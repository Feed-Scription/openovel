import {
  formatTransactions,
  listStoryTransactions,
  rollbackStoryTransaction,
} from "../storyTransaction.js"

export async function transactionsText({ limit = 20 } = {}) {
  const transactions = await listStoryTransactions({ limit })
  return formatTransactions(transactions)
}

export async function rollbackTransactionText(txId) {
  if (!txId) return "Usage: /rollback <txId>"
  const result = await rollbackStoryTransaction(txId)
  const lines = [
    `Rolled back ${result.txId}`,
    ...result.rolledBack.map((file) => `- ${file.action}: ${file.path}`),
  ]
  return lines.join("\n")
}
