import { EventEmitter } from "node:events"

export class Bus {
  #emitter = new EventEmitter()

  publish(type, properties = {}) {
    const event = {
      id: `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      type,
      at: new Date().toISOString(),
      properties,
    }
    this.#emitter.emit(type, event)
    this.#emitter.emit("*", event)
    return event
  }

  subscribe(type, callback) {
    this.#emitter.on(type, callback)
    return () => this.#emitter.off(type, callback)
  }

  subscribeAll(callback) {
    return this.subscribe("*", callback)
  }
}

export const bus = new Bus()
