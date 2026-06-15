import {
  formatPermissionRequests,
  listPermissionRequests,
  resolvePermissionRequest,
} from "../permissionService.js"

export async function permissionsText({ status = "pending", limit = 20, ledgerPath } = {}) {
  const requests = await listPermissionRequests({ status, limit, ledgerPath })
  return formatPermissionRequests(requests)
}

export async function approvePermissionText(requestId, { ledgerPath } = {}) {
  if (!requestId) throw new Error("Usage: /approve <permissionRequestId>")
  const resolved = await resolvePermissionRequest(requestId, "approved", "", { ledgerPath })
  return `Approved permission request ${resolved.requestId}.`
}

export async function denyPermissionText(requestId, reason = "", { ledgerPath } = {}) {
  if (!requestId) throw new Error("Usage: /deny <permissionRequestId> [reason]")
  const resolved = await resolvePermissionRequest(requestId, "denied", reason, { ledgerPath })
  return `Denied permission request ${resolved.requestId}${reason ? `: ${reason}` : "."}`
}
