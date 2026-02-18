export class SignalingClient {
  /**
   * @param {{ signalingUrl: string, roomId: string, onMessage: (msg: any) => void, onOpen?: () => void, onClose?: (ev: CloseEvent) => void, onError?: (ev: Event) => void }} options
   */
  constructor({ signalingUrl, roomId, onMessage, onOpen, onClose, onError }) {
    this.signalingUrl = signalingUrl;
    this.roomId = roomId;
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.onError = onError;
    this.ws = null;
  }

  connect() {
    this.ws = new WebSocket(this.signalingUrl);

    this.ws.addEventListener("open", () => {
      this.send("join", {});
      this.onOpen?.();
    });

    this.ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        this.onMessage(data);
      } catch (error) {
        console.error("Failed to parse signaling message", error);
      }
    });

    this.ws.addEventListener("close", (event) => this.onClose?.(event));
    this.ws.addEventListener("error", (event) => this.onError?.(event));
  }

  send(type, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(
      JSON.stringify({
        type,
        roomId: this.roomId,
        payload,
      }),
    );
  }

  close() {
    this.ws?.close();
  }
}
