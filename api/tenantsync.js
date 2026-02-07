// api/tenantsync.js
// TenantSync API v2.0 - Full hub transfer with package storage
// Now supports: upload zip -> store -> download zip (no local file paths needed)
//
// Package Storage Strategy:
//   - Small packages (<4MB): stored as base64 in database (ts_sync_queue.package_data)
//   - Large packages (>4MB): chunked upload, stored across multiple rows in ts_package_chunks
//   - Download: reassemble chunks and serve as base64
//
// Authors: Joe Green and Claude AI

import crypto from 'crypto';

// Max inline package size (4MB base64 ~ 3MB binary)
const MAX_INLINE_SIZE = 4 * 1024 * 1024;
// Chunk size for large packages (3MB per chunk)
const CHUNK_SIZE = 3 * 1024 * 1024;

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const { neon } = await import('@neondatabase/serverless');
        const sql = neon(process.env.DATABASE_URL);
        
        const action = req.query.action || req.body?.action;
        
        // Routes that don't require auth
        if (action === 'register') {
            return await handleRegister(req, res, sql);
        }
        if (action === 'setup-chunks-table') {
            return await handleSetupChunksTable(req, res, sql);
        }
        
        // All other routes require API key
        const apiKey = req.headers['x-api-key'];
        if (!apiKey) {
            return res.status(401).json({ error: 'API key required' });
        }
        
        const customer = await validateApiKey(sql, apiKey);
        if (!customer) {
            return res.status(401).json({ error: 'Invalid API key' });
        }
        
        switch (action) {
            case 'status':
                return await handleStatus(req, res, sql, customer);
            case 'pairs':
                return await handlePairs(req, res, sql, customer);
            case 'create-pair':
                return await handleCreatePair(req, res, sql, customer);
            case 'upload':
                return await handleUpload(req, res, sql, customer);
            case 'upload-chunk':
                return await handleUploadChunk(req, res, sql, customer);
            case 'upload-complete':
                return await handleUploadComplete(req, res, sql, customer);
            case 'download':
                return await handleDownload(req, res, sql, customer);
            case 'download-chunk':
                return await handleDownloadChunk(req, res, sql, customer);
            case 'conflicts':
                return await handleConflicts(req, res, sql, customer);
            case 'resolve':
                return await handleResolve(req, res, sql, customer);
            case 'ledger':
                return await handleLedger(req, res, sql, customer);
            case 'sync-complete':
                return await handleSyncComplete(req, res, sql, customer);
            default:
                return res.status(400).json({ error: 'Unknown action', validActions: [
                    'register', 'status', 'pairs', 'create-pair', 
                    'upload', 'upload-chunk', 'upload-complete',
                    'download', 'download-chunk',
                    'conflicts', 'resolve', 'ledger', 'sync-complete'
                ]});
        }
    } catch (error) {
        console.error('TenantSync API Error:', error);
        return res.status(500).json({ error: error.message });
    }
}

// ============================================================================
// HELPERS
// ============================================================================

function generateApiKey() {
    return 'ts_live_' + crypto.randomBytes(24).toString('hex');
}

function hashApiKey(apiKey) {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
}

async function validateApiKey(sql, apiKey) {
    const hash = hashApiKey(apiKey);
    const result = await sql`
        SELECT * FROM ts_customers 
        WHERE api_key_hash = ${hash} 
        AND subscription_status IN ('active', 'trial')
    `;
    return result[0] || null;
}

async function logAudit(sql, customerId, syncPairId, action, details) {
    await sql`
        INSERT INTO ts_audit_log (customer_id, sync_pair_id, action, details)
        VALUES (${customerId}, ${syncPairId}, ${action}, ${JSON.stringify(details)})
    `;
}

// ============================================================================
// SETUP - Create chunks table (run once)
// ============================================================================
async function handleSetupChunksTable(req, res, sql) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'POST required' });
    }
    
    await sql`
        CREATE TABLE IF NOT EXISTS ts_package_chunks (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            queue_id UUID NOT NULL,
            chunk_index INTEGER NOT NULL,
            chunk_data TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(queue_id, chunk_index)
        )
    `;
    
    await sql`
        CREATE INDEX IF NOT EXISTS idx_chunks_queue ON ts_package_chunks(queue_id, chunk_index)
    `;
    
    // Also add package columns to sync_queue if not exists
    try {
        await sql`ALTER TABLE ts_sync_queue ADD COLUMN IF NOT EXISTS package_data TEXT`;
        await sql`ALTER TABLE ts_sync_queue ADD COLUMN IF NOT EXISTS package_size_bytes BIGINT`;
        await sql`ALTER TABLE ts_sync_queue ADD COLUMN IF NOT EXISTS total_chunks INTEGER DEFAULT 0`;
        await sql`ALTER TABLE ts_sync_queue ADD COLUMN IF NOT EXISTS chunks_received INTEGER DEFAULT 0`;
    } catch (e) {
        // Columns may already exist
    }
    
    return res.status(200).json({ 
        success: true, 
        message: 'Chunks table and queue columns created' 
    });
}

// ============================================================================
// REGISTER
// ============================================================================
async function handleRegister(req, res, sql) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'POST required' });
    }
    
    const { company_name, contact_email, contact_name } = req.body;
    
    if (!company_name || !contact_email) {
        return res.status(400).json({ error: 'company_name and contact_email required' });
    }
    
    const existing = await sql`
        SELECT id FROM ts_customers WHERE contact_email = ${contact_email}
    `;
    if (existing.length > 0) {
        return res.status(409).json({ error: 'Email already registered' });
    }
    
    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);
    const apiKeyPrefix = apiKey.substring(0, 12);
    
    const result = await sql`
        INSERT INTO ts_customers (
            company_name, contact_email, contact_name, 
            api_key_hash, api_key_prefix,
            subscription_tier, subscription_status
        ) VALUES (
            ${company_name}, ${contact_email}, ${contact_name || null},
            ${apiKeyHash}, ${apiKeyPrefix},
            'starter', 'trial'
        )
        RETURNING id, company_name, subscription_tier, max_sync_pairs, max_flows_per_pair
    `;
    
    await logAudit(sql, result[0].id, null, 'customer_registered', { 
        company: company_name, tier: 'starter' 
    });
    
    return res.status(201).json({
        success: true,
        customer: result[0],
        api_key: apiKey,
        warning: 'Save your API key now - it cannot be retrieved later!'
    });
}

// ============================================================================
// STATUS
// ============================================================================
async function handleStatus(req, res, sql, customer) {
    const pairs = await sql`
        SELECT COUNT(*) as count FROM ts_sync_pairs WHERE customer_id = ${customer.id}
    `;
    const usage = await sql`
        SELECT * FROM ts_usage_metrics 
        WHERE customer_id = ${customer.id} AND date = CURRENT_DATE
    `;
    const conflicts = await sql`
        SELECT COUNT(*) as count FROM ts_conflicts 
        WHERE customer_id = ${customer.id} AND resolution = 'unresolved'
    `;
    
    return res.status(200).json({
        customer: {
            id: customer.id,
            company_name: customer.company_name,
            tier: customer.subscription_tier,
            status: customer.subscription_status
        },
        limits: {
            max_sync_pairs: customer.max_sync_pairs,
            max_flows_per_pair: customer.max_flows_per_pair,
            bidirectional_enabled: customer.bidirectional_enabled
        },
        usage: {
            sync_pairs: parseInt(pairs[0]?.count || 0),
            syncs_today: usage[0]?.syncs_initiated || 0,
            flows_synced_today: usage[0]?.flows_synced || 0,
            conflicts_pending: parseInt(conflicts[0]?.count || 0)
        }
    });
}

// ============================================================================
// PAIRS
// ============================================================================
async function handlePairs(req, res, sql, customer) {
    const pairs = await sql`
        SELECT 
            id, pair_name, 
            source_tenant_id, source_environment_id, source_dataverse_org,
            target_tenant_id, target_environment_id, target_dataverse_org,
            sync_direction, sync_frequency,
            last_sync_at, next_sync_at, status, flows_synced
        FROM ts_sync_pairs 
        WHERE customer_id = ${customer.id}
        ORDER BY created_at DESC
    `;
    return res.status(200).json({ pairs });
}

// ============================================================================
// CREATE-PAIR
// ============================================================================
async function handleCreatePair(req, res, sql, customer) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'POST required' });
    }
    
    const { pair_name, source_tenant_id, target_tenant_id, source_environment_id, target_environment_id, source_dataverse_org, target_dataverse_org, sync_direction, sync_frequency } = req.body;
    
    if (!pair_name || !source_tenant_id || !target_tenant_id) {
        return res.status(400).json({ error: 'pair_name, source_tenant_id, target_tenant_id required' });
    }
    
    const pairCount = await sql`
        SELECT COUNT(*) as count FROM ts_sync_pairs WHERE customer_id = ${customer.id}
    `;
    if (parseInt(pairCount[0].count) >= customer.max_sync_pairs) {
        return res.status(403).json({ error: 'Sync pair limit reached', limit: customer.max_sync_pairs });
    }
    
    if (sync_direction === 'bidirectional' && !customer.bidirectional_enabled) {
        return res.status(403).json({ error: 'Bidirectional sync requires Enterprise tier' });
    }
    
    const result = await sql`
        INSERT INTO ts_sync_pairs (
            customer_id, pair_name,
            source_tenant_id, source_environment_id, source_dataverse_org,
            target_tenant_id, target_environment_id, target_dataverse_org,
            sync_direction, sync_frequency
        ) VALUES (
            ${customer.id}, ${pair_name},
            ${source_tenant_id}, ${source_environment_id || 'Default-' + source_tenant_id}, ${source_dataverse_org || null},
            ${target_tenant_id}, ${target_environment_id || 'Default-' + target_tenant_id}, ${target_dataverse_org || null},
            ${sync_direction || 'one_way'}, ${sync_frequency || 'manual'}
        )
        RETURNING *
    `;
    
    await logAudit(sql, customer.id, result[0].id, 'sync_pair_created', { pair_name });
    
    return res.status(201).json({ success: true, pair: result[0] });
}

// ============================================================================
// UPLOAD - Small packages (< 4MB) or manifest-only
// ============================================================================
async function handleUpload(req, res, sql, customer) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'POST required' });
    }
    
    const { sync_pair_id, manifest, package_base64 } = req.body;
    
    if (!sync_pair_id || !manifest) {
        return res.status(400).json({ error: 'sync_pair_id and manifest required' });
    }
    
    const pair = await sql`
        SELECT * FROM ts_sync_pairs 
        WHERE id = ${sync_pair_id}::uuid AND customer_id = ${customer.id}
    `;
    if (pair.length === 0) {
        return res.status(404).json({ error: 'Sync pair not found' });
    }
    
    // Store package if provided (small packages only)
    const packageSize = package_base64 ? package_base64.length : 0;
    
    const result = await sql`
        INSERT INTO ts_sync_queue (
            customer_id, sync_pair_id, direction, manifest, status,
            package_data, package_size_bytes
        ) VALUES (
            ${customer.id}, ${sync_pair_id}::uuid, 'inbound', 
            ${JSON.stringify(manifest)}, 
            ${package_base64 ? 'completed' : 'pending'},
            ${package_base64 || null},
            ${packageSize}
        )
        RETURNING id
    `;
    
    // Update usage
    await sql`
        INSERT INTO ts_usage_metrics (customer_id, date, syncs_initiated)
        VALUES (${customer.id}, CURRENT_DATE, 1)
        ON CONFLICT (customer_id, date) 
        DO UPDATE SET syncs_initiated = ts_usage_metrics.syncs_initiated + 1
    `;
    
    await logAudit(sql, customer.id, sync_pair_id, 'sync_upload_received', {
        queue_id: result[0].id,
        has_package: !!package_base64,
        package_size: packageSize,
        flows: manifest.components?.flows?.length || 0
    });
    
    return res.status(202).json({
        success: true,
        queue_id: result[0].id,
        status: package_base64 ? 'completed' : 'pending',
        has_package: !!package_base64,
        message: package_base64 
            ? 'Package stored successfully' 
            : 'Manifest queued (use upload-chunk for large packages)'
    });
}

// ============================================================================
// UPLOAD-CHUNK - For large packages (> 4MB), upload in chunks
// ============================================================================
async function handleUploadChunk(req, res, sql, customer) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'POST required' });
    }
    
    const { queue_id, chunk_index, chunk_data, total_chunks } = req.body;
    
    if (!queue_id || chunk_index === undefined || !chunk_data) {
        return res.status(400).json({ error: 'queue_id, chunk_index, chunk_data required' });
    }
    
    // Verify queue entry belongs to customer
    const queue = await sql`
        SELECT id FROM ts_sync_queue 
        WHERE id = ${queue_id}::uuid AND customer_id = ${customer.id}
    `;
    if (queue.length === 0) {
        return res.status(404).json({ error: 'Queue entry not found' });
    }
    
    // Update total_chunks on queue if provided
    if (total_chunks && chunk_index === 0) {
        await sql`
            UPDATE ts_sync_queue 
            SET total_chunks = ${total_chunks}, status = 'processing'
            WHERE id = ${queue_id}::uuid
        `;
    }
    
    // Store chunk
    await sql`
        INSERT INTO ts_package_chunks (queue_id, chunk_index, chunk_data)
        VALUES (${queue_id}::uuid, ${chunk_index}, ${chunk_data})
        ON CONFLICT (queue_id, chunk_index) DO UPDATE SET chunk_data = ${chunk_data}
    `;
    
    // Update chunks received count
    const chunkCount = await sql`
        SELECT COUNT(*) as count FROM ts_package_chunks WHERE queue_id = ${queue_id}::uuid
    `;
    
    await sql`
        UPDATE ts_sync_queue 
        SET chunks_received = ${parseInt(chunkCount[0].count)}
        WHERE id = ${queue_id}::uuid
    `;
    
    return res.status(200).json({
        success: true,
        chunk_index,
        chunks_received: parseInt(chunkCount[0].count),
        total_chunks: total_chunks || null
    });
}

// ============================================================================
// UPLOAD-COMPLETE - Signal that all chunks are uploaded
// ============================================================================
async function handleUploadComplete(req, res, sql, customer) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'POST required' });
    }
    
    const { queue_id } = req.body;
    
    if (!queue_id) {
        return res.status(400).json({ error: 'queue_id required' });
    }
    
    // Verify and get queue entry
    const queue = await sql`
        SELECT * FROM ts_sync_queue 
        WHERE id = ${queue_id}::uuid AND customer_id = ${customer.id}
    `;
    if (queue.length === 0) {
        return res.status(404).json({ error: 'Queue entry not found' });
    }
    
    // Count chunks
    const chunks = await sql`
        SELECT COUNT(*) as count, SUM(LENGTH(chunk_data)) as total_size
        FROM ts_package_chunks WHERE queue_id = ${queue_id}::uuid
    `;
    
    const totalChunks = parseInt(chunks[0].count);
    const totalSize = parseInt(chunks[0].total_size || 0);
    
    // Mark as completed
    await sql`
        UPDATE ts_sync_queue 
        SET status = 'completed', 
            total_chunks = ${totalChunks},
            chunks_received = ${totalChunks},
            package_size_bytes = ${totalSize},
            processing_completed_at = NOW()
        WHERE id = ${queue_id}::uuid
    `;
    
    await logAudit(sql, customer.id, queue[0].sync_pair_id, 'chunked_upload_completed', {
        queue_id, total_chunks: totalChunks, total_size: totalSize
    });
    
    return res.status(200).json({
        success: true,
        queue_id,
        total_chunks: totalChunks,
        total_size_bytes: totalSize,
        status: 'completed'
    });
}

// ============================================================================
// DOWNLOAD - Get latest package for a sync pair
// ============================================================================
async function handleDownload(req, res, sql, customer) {
    const { sync_pair_id } = req.query;
    
    if (!sync_pair_id) {
        return res.status(400).json({ error: 'sync_pair_id required' });
    }
    
    // Get the most recent completed inbound package
    const packages = await sql`
        SELECT id, manifest, package_data, package_size_bytes, total_chunks, created_at
        FROM ts_sync_queue 
        WHERE customer_id = ${customer.id} 
        AND sync_pair_id = ${sync_pair_id}::uuid
        AND direction = 'inbound'
        AND status = 'completed'
        ORDER BY created_at DESC
        LIMIT 1
    `;
    
    if (packages.length === 0) {
        return res.status(200).json({ available: false, message: 'No packages ready' });
    }
    
    const pkg = packages[0];
    const isChunked = pkg.total_chunks > 0 && !pkg.package_data;
    
    if (pkg.package_data) {
        // Small package - return inline
        return res.status(200).json({
            available: true,
            transfer_mode: 'inline',
            package: {
                queue_id: pkg.id,
                manifest: pkg.manifest,
                package_base64: pkg.package_data,
                size_bytes: pkg.package_size_bytes,
                created_at: pkg.created_at
            }
        });
    }
    else if (isChunked) {
        // Large package - return metadata, client uses download-chunk
        return res.status(200).json({
            available: true,
            transfer_mode: 'chunked',
            package: {
                queue_id: pkg.id,
                manifest: pkg.manifest,
                total_chunks: pkg.total_chunks,
                size_bytes: pkg.package_size_bytes,
                created_at: pkg.created_at
            }
        });
    }
    else {
        // Manifest only (legacy - no package stored)
        return res.status(200).json({
            available: true,
            transfer_mode: 'manifest_only',
            package: {
                queue_id: pkg.id,
                manifest: pkg.manifest,
                created_at: pkg.created_at
            }
        });
    }
}

// ============================================================================
// DOWNLOAD-CHUNK - Get a specific chunk of a large package
// ============================================================================
async function handleDownloadChunk(req, res, sql, customer) {
    const { queue_id, chunk_index } = req.query;
    
    if (!queue_id || chunk_index === undefined) {
        return res.status(400).json({ error: 'queue_id and chunk_index required' });
    }
    
    // Verify queue belongs to customer
    const queue = await sql`
        SELECT id FROM ts_sync_queue 
        WHERE id = ${queue_id}::uuid AND customer_id = ${customer.id}
    `;
    if (queue.length === 0) {
        return res.status(404).json({ error: 'Queue entry not found' });
    }
    
    // Get chunk
    const chunk = await sql`
        SELECT chunk_data FROM ts_package_chunks 
        WHERE queue_id = ${queue_id}::uuid AND chunk_index = ${parseInt(chunk_index)}
    `;
    
    if (chunk.length === 0) {
        return res.status(404).json({ error: 'Chunk not found' });
    }
    
    return res.status(200).json({
        queue_id,
        chunk_index: parseInt(chunk_index),
        chunk_data: chunk[0].chunk_data
    });
}

// ============================================================================
// CONFLICTS
// ============================================================================
async function handleConflicts(req, res, sql, customer) {
    const conflicts = await sql`
        SELECT c.*, sp.pair_name
        FROM ts_conflicts c
        JOIN ts_sync_pairs sp ON c.sync_pair_id = sp.id
        WHERE c.customer_id = ${customer.id} AND c.resolution = 'unresolved'
        ORDER BY c.created_at DESC
    `;
    return res.status(200).json({ conflicts });
}

// ============================================================================
// RESOLVE
// ============================================================================
async function handleResolve(req, res, sql, customer) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'POST required' });
    }
    
    const { conflict_id, resolution } = req.body;
    if (!conflict_id || !resolution) {
        return res.status(400).json({ error: 'conflict_id and resolution required' });
    }
    if (!['keep_a', 'keep_b', 'merge', 'skip'].includes(resolution)) {
        return res.status(400).json({ error: 'Invalid resolution' });
    }
    
    const result = await sql`
        UPDATE ts_conflicts 
        SET resolution = ${resolution}, resolved_at = NOW(), resolved_by = ${customer.company_name}
        WHERE id = ${conflict_id}::uuid AND customer_id = ${customer.id}
        RETURNING *
    `;
    
    if (result.length === 0) {
        return res.status(404).json({ error: 'Conflict not found' });
    }
    
    await logAudit(sql, customer.id, result[0].sync_pair_id, 'conflict_resolved', {
        conflict_id, resolution
    });
    
    await sql`
        INSERT INTO ts_usage_metrics (customer_id, date, conflicts_resolved)
        VALUES (${customer.id}, CURRENT_DATE, 1)
        ON CONFLICT (customer_id, date) 
        DO UPDATE SET conflicts_resolved = ts_usage_metrics.conflicts_resolved + 1
    `;
    
    return res.status(200).json({ success: true, conflict: result[0] });
}

// ============================================================================
// LEDGER
// ============================================================================
async function handleLedger(req, res, sql, customer) {
    const { sync_pair_id } = req.query;
    if (!sync_pair_id) {
        return res.status(400).json({ error: 'sync_pair_id required' });
    }
    
    const ledger = await sql`
        SELECT * FROM ts_version_ledger 
        WHERE customer_id = ${customer.id} AND sync_pair_id = ${sync_pair_id}::uuid
        ORDER BY flow_name ASC
    `;
    
    return res.status(200).json({ sync_pair_id, flows: ledger, total: ledger.length });
}

// ============================================================================
// SYNC-COMPLETE - Desktop app reports sync results
// ============================================================================
async function handleSyncComplete(req, res, sql, customer) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'POST required' });
    }
    
    const { 
        sync_pair_id, 
        status,           // 'success' or 'failed'
        flows_processed,  // number of flows in solution
        flows_activated,  // number successfully activated
        flows_skipped,    // number needing connections
        flows_failed,     // number that errored
        duration_seconds, // how long sync took
        solution_name,    // which solution was synced
        error_message,    // error details if failed
        source_org,       // source dataverse org
        target_org,       // target dataverse org
        app_version       // desktop app version
    } = req.body;
    
    if (!status) {
        return res.status(400).json({ error: 'status required (success or failed)' });
    }
    
    // Insert into sync_history
    const history = await sql`
        INSERT INTO sync_history (
            sync_pair_id, 
            started_at, 
            completed_at, 
            flows_processed, 
            status, 
            error_message
        ) VALUES (
            ${sync_pair_id || null},
            NOW() - INTERVAL '1 second' * ${duration_seconds || 0},
            NOW(),
            ${flows_processed || 0},
            ${status},
            ${error_message || null}
        ) RETURNING *
    `;
    
    // Update sync_pairs if we have a pair_id
    if (sync_pair_id) {
        await sql`
            UPDATE ts_sync_pairs 
            SET last_sync_at = NOW(),
                last_sync_status = ${status},
                flows_synced = COALESCE(flows_synced, 0) + ${flows_activated || 0}
            WHERE id = ${sync_pair_id}::uuid AND customer_id = ${customer.id}
        `;
    }
    
    // Update usage metrics
    if (status === 'success') {
        await sql`
            INSERT INTO ts_usage_metrics (customer_id, date, syncs_completed, flows_synced)
            VALUES (${customer.id}, CURRENT_DATE, 1, ${flows_activated || 0})
            ON CONFLICT (customer_id, date) 
            DO UPDATE SET 
                syncs_completed = ts_usage_metrics.syncs_completed + 1,
                flows_synced = ts_usage_metrics.flows_synced + ${flows_activated || 0}
        `;
    } else {
        await sql`
            INSERT INTO ts_usage_metrics (customer_id, date, syncs_failed)
            VALUES (${customer.id}, CURRENT_DATE, 1)
            ON CONFLICT (customer_id, date) 
            DO UPDATE SET syncs_failed = ts_usage_metrics.syncs_failed + 1
        `;
    }
    
    // Audit log
    await logAudit(sql, customer.id, sync_pair_id, 'sync_completed', {
        status, flows_processed, flows_activated, flows_skipped, flows_failed,
        duration_seconds, solution_name, source_org, target_org, app_version
    });
    
    return res.status(200).json({ 
        success: true, 
        history_id: history[0]?.id,
        message: `Sync ${status} recorded`
    });
}
