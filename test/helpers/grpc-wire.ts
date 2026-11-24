function frame(bytes: Uint8Array, flags = 0): Uint8Array {
  const framed = new Uint8Array(bytes.length + 5);
  framed[0] = flags;
  new DataView(framed.buffer).setUint32(1, bytes.length);
  framed.set(bytes, 5);
  return framed;
}

export function wireBody(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const data = frame(bytes);
  const trailers = frame(new TextEncoder().encode("grpc-status: 0\r\n"), 128);
  const body = new Uint8Array(data.length + trailers.length);
  body.set(data);
  body.set(trailers, data.length);
  return body;
}

export function wireResponse(bytes: Uint8Array): Response {
  return new Response(wireBody(bytes), { headers: { "content-type": "application/grpc-web+proto" } });
}
