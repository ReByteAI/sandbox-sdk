/**
 * Portal Connect RPC Test Setup
 *
 * Tests run against portal on localhost without needing a VM.
 * Since Connect RPC is just HTTP + JSON, we can test directly.
 */

import { createGrpcWebTransport } from '@connectrpc/connect-web'
import { createClient } from '@connectrpc/connect'
import { Process } from '../../src/envd/process/process_pb'
import { Filesystem } from '../../src/envd/filesystem/filesystem_pb'

const PORTAL_URL = process.env.PORTAL_URL || 'http://localhost:49983'

export const transport = createGrpcWebTransport({
  baseUrl: PORTAL_URL,
  useBinaryFormat: true,
})

export const processClient = createClient(Process, transport)
export const filesystemClient = createClient(Filesystem, transport)

export { PORTAL_URL }
