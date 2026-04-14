const VLESS_UUID = '1dfdf3f2-186b-4bae-84d5-0c7cff226a92';

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Страница приветствия — чтобы домен не выглядел пустым
    if (url.pathname === '/') {
      return new Response('OK', { status: 200 });
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader === 'websocket') {
      return handleVLESS(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};

async function handleVLESS(request) {
  const [client, server] = new WebSocketPair();
  server.accept();

  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = makeReadableWebSocketStream(server, earlyDataHeader);

  let remoteSocket = { value: null };
  let udpStreamWrite = null;
  let isDns = false;

  readableStream.pipeTo(new WritableStream({
    async write(chunk) {
      if (isDns && udpStreamWrite) {
        return udpStreamWrite(chunk);
      }
      if (remoteSocket.value) {
        const writer = remoteSocket.value.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }

      const {
        hasError,
        portRemote,
        addressRemote,
        rawDataIndex,
        vlessVersion,
        isUDP,
      } = processVlessHeader(chunk, VLESS_UUID);

      if (hasError) return;

      const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);

      if (isUDP && portRemote === 53) {
        isDns = true;
        const { write } = await handleUDP(server, vlessResponseHeader);
        udpStreamWrite = write;
        udpStreamWrite(rawClientData);
        return;
      }

      handleTCP(remoteSocket, addressRemote, portRemote, rawClientData, server, vlessResponseHeader);
    },
    close() {},
    abort(reason) {},
  })).catch(() => {});

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

function makeReadableWebSocketStream(webSocket, earlyDataHeader) {
  let readableStreamCancel = false;

  const stream = new ReadableStream({
    start(controller) {
      webSocket.addEventListener('message', (event) => {
        if (readableStreamCancel) return;
        controller.enqueue(event.data);
      });

      webSocket.addEventListener('close', () => {
        safeCloseWebSocket(webSocket);
        if (readableStreamCancel) return;
        controller.close();
      });

      webSocket.addEventListener('error', (err) => {
        controller.error(err);
      });

      if (earlyDataHeader) {
        try {
          const base64 = earlyDataHeader.replace(/-/g, '+').replace(/_/g, '/');
          const decoded = atob(base64);
          const arr = new Uint8Array(decoded.length);
          for (let i = 0; i < decoded.length; i++) {
            arr[i] = decoded.charCodeAt(i);
          }
          controller.enqueue(arr.buffer);
        } catch (e) {}
      }
    },
    cancel() {
      readableStreamCancel = true;
      safeCloseWebSocket(webSocket);
    },
  });

  return stream;
}

function processVlessHeader(buffer, uuid) {
  if (buffer.byteLength < 24) {
    return { hasError: true };
  }

  const view = new DataView(buffer);
  const version = new Uint8Array(buffer.slice(0, 1));

  // Проверка UUID
  const uuidBytes = new Uint8Array(buffer.slice(1, 17));
  const uuidHex = [...uuidBytes].map(b => b.toString(16).padStart(2, '0')).join('');
  const formattedUUID = `${uuidHex.slice(0,8)}-${uuidHex.slice(8,12)}-${uuidHex.slice(12,16)}-${uuidHex.slice(16,20)}-${uuidHex.slice(20)}`;

  if (formattedUUID !== uuid) {
    return { hasError: true };
  }

  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength);

  // 1 = TCP, 2 = UDP
  const isUDP = command === 2;
  if (command !== 1 && command !== 2) {
    return { hasError: true };
  }

  const portRemote = view.getUint16(19 + optLength);
  const addressType = view.getUint8(21 + optLength);

  let addressRemote = '';
  let addressLength = 0;
  let addressValueIndex = 22 + optLength;

  switch (addressType) {
    case 1: // IPv4
      addressLength = 4;
      addressRemote = new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    case 2: // Domain
      addressLength = view.getUint8(addressValueIndex);
      addressValueIndex++;
      addressRemote = new TextDecoder().decode(buffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3: // IPv6
      addressLength = 16;
      const ipv6Bytes = new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + addressLength));
      addressRemote = [...Array(8)].map((_, i) =>
        ((ipv6Bytes[i * 2] << 8) | ipv6Bytes[i * 2 + 1]).toString(16)
      ).join(':');
      break;
    default:
      return { hasError: true };
  }

  return {
    hasError: false,
    addressRemote,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP,
  };
}

async function handleTCP(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader) {
  async function connectAndWrite(address, port) {
    const tcpSocket = connect({ hostname: address, port });
    remoteSocket.value = tcpSocket;
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return tcpSocket;
  }

  async function retry() {
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    tcpSocket.closed.catch(() => {}).finally(() => safeCloseWebSocket(webSocket));
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null);
  }

  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry);
}

async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry) {
  let hasIncomingData = false;
  let vlessHeaderSent = false;

  await remoteSocket.readable.pipeTo(new WritableStream({
    async write(chunk) {
      hasIncomingData = true;

      if (webSocket.readyState !== WS_READY_STATE_OPEN) return;

      if (!vlessHeaderSent) {
        vlessHeaderSent = true;
        const combined = new Uint8Array(vlessResponseHeader.byteLength + chunk.byteLength);
        combined.set(vlessResponseHeader, 0);
        combined.set(new Uint8Array(chunk), vlessResponseHeader.byteLength);
        webSocket.send(combined.buffer);
        return;
      }

      webSocket.send(chunk);
    },
    close() {},
    abort() {},
  })).catch(() => {});

  if (!hasIncomingData && retry) {
    retry();
  }
}

async function handleUDP(webSocket, vlessResponseHeader) {
  let headerSent = false;

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      // DNS over UDP — парсим длину пакета
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPktSize = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPktSize));
        index += 2 + udpPktSize;
        controller.enqueue(udpData);
      }
    }
  });

  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk) {
      const resp = await fetch('https://1.1.1.1/dns-query', {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message' },
        body: chunk,
      });

      const dnsResult = await resp.arrayBuffer();
      const udpSize = dnsResult.byteLength;
      const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

      if (webSocket.readyState === WS_READY_STATE_OPEN) {
        if (!headerSent) {
          headerSent = true;
          const combined = new Uint8Array(vlessResponseHeader.byteLength + 2 + udpSize);
          combined.set(vlessResponseHeader, 0);
          combined.set(udpSizeBuffer, vlessResponseHeader.byteLength);
          combined.set(new Uint8Array(dnsResult), vlessResponseHeader.byteLength + 2);
          webSocket.send(combined.buffer);
        } else {
          const combined = new Uint8Array(2 + udpSize);
          combined.set(udpSizeBuffer, 0);
          combined.set(new Uint8Array(dnsResult), 2);
          webSocket.send(combined.buffer);
        }
      }
    }
  })).catch(() => {});

  const writer = transformStream.writable.getWriter();

  return {
    write(chunk) {
      writer.write(chunk);
    }
  };
}

function safeCloseWebSocket(socket) {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close();
    }
  } catch (e) {}
}
