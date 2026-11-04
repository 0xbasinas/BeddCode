import { serveApprovalMcp, SOCKET_ENV } from './approvalBridge.ts'
const path = process.env[SOCKET_ENV]
if (!path) throw new Error(`${SOCKET_ENV} is required`)
serveApprovalMcp(process.stdin, process.stdout, path)
