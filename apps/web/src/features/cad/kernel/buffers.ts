/** ArrayBuffer covering exactly this view, reused when the view already owns its buffer. */
export function exactBuffer(view: ArrayBufferView): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = view
  if (buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength)
    return buffer
  const copy = new ArrayBuffer(byteLength)
  new Uint8Array(copy).set(new Uint8Array(buffer, byteOffset, byteLength))
  return copy
}
