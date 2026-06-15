// The Electron client runs the SessionViewModel embedded, in-process. The
// transport exposes the same surface the IPC layer expects:
//   { getState(): ViewState, dispatch(method, args): Promise, shutdown() }
// plus the constructor's onState / onBusEvent callbacks that forward to IPC.

import { createEmbeddedTransport } from "./embedded.js"

export async function createTransport({ onState, onBusEvent }) {
  return createEmbeddedTransport({ onState, onBusEvent })
}
