import assert from 'node:assert/strict'
import test from 'node:test'
import { watchRemoval } from './embed.ts'

class TestObserver {
  static current: TestObserver | undefined
  callback: () => void
  disconnected = false
  constructor(callback: () => void) {
    this.callback = callback
    TestObserver.current = this
  }
  observe(): void {}
  disconnect(): void { this.disconnected = true }
}

test('disposes the embedded runtime once when the host is removed', () => {
  let isConnected = true
  let disposeCount = 0
  watchRemoval({ get isConnected() { return isConnected }, ownerDocument: {} as Document }, () => disposeCount++, TestObserver as unknown as typeof MutationObserver)
  isConnected = false
  TestObserver.current?.callback()
  TestObserver.current?.callback()
  assert.equal(disposeCount, 1)
  assert.equal(TestObserver.current?.disconnected, true)
})

test('manual disposal releases once and disconnects the observer', () => {
  let isConnected = true
  let disposeCount = 0
  const stop = watchRemoval({ get isConnected() { return isConnected }, ownerDocument: {} as Document }, () => disposeCount++, TestObserver as unknown as typeof MutationObserver)
  stop()
  isConnected = false
  TestObserver.current?.callback()
  assert.equal(disposeCount, 1)
  assert.equal(TestObserver.current?.disconnected, true)
})
test('an already detached host is disposed immediately', () => {
  let disposeCount = 0
  const stop = watchRemoval({ isConnected: false, ownerDocument: {} as Document }, () => disposeCount++, TestObserver as unknown as typeof MutationObserver)
  assert.equal(disposeCount, 1)
  assert.equal(TestObserver.current?.disconnected, true)
  stop()
  assert.equal(disposeCount, 1)
})
