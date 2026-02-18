import { SignalingClient } from "./signaling.js";

const startButton = document.querySelector("#startBtn");
const signalingInput = document.querySelector("#signalingUrl");
const roomInput = document.querySelector("#roomId");
const localVideo = document.querySelector("#localVideo");
const remoteVideo = document.querySelector("#remoteVideo");
const logOutput = document.querySelector("#logs");

function getDefaultSignalingUrl() {
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${window.location.host}/ws`;
}

signalingInput.value = getDefaultSignalingUrl();

function log(message) {
  const now = new Date().toISOString();
  logOutput.textContent += `[${now}] ${message}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
}

/**
 * You can add TURN later like:
 * {
 *   urls: "turn:turn.example.com:3478",
 *   username: "user",
 *   credential: "pass"
 * }
 */
const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

let signaling = null;
let pc = null;
let makingOffer = false;
let ignoreOffer = false;
let role = null;
let isStarted = false;

async function createAndSendOffer() {
  if (!pc || role !== "offerer" || makingOffer || pc.signalingState !== "stable") {
    return;
  }

  try {
    makingOffer = true;
    await pc.setLocalDescription(await pc.createOffer());
    signaling.send("offer", {
      sdp: pc.localDescription,
    });
    log("Sent offer.");
  } catch (error) {
    log(`Failed to create offer: ${error.message}`);
  } finally {
    makingOffer = false;
  }
}

async function initCall() {
  if (isStarted) {
    log("Call already started.");
    return;
  }

  const signalingUrl = signalingInput.value.trim();
  const roomId = roomInput.value.trim();

  if (!signalingUrl || !roomId) {
    log("Please provide signaling URL and room ID.");
    return;
  }

  isStarted = true;
  startButton.disabled = true;

  const localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true,
  });
  localVideo.srcObject = localStream;

  pc = new RTCPeerConnection(rtcConfig);

  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }

  pc.ontrack = (event) => {
    if (remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      log("Remote stream attached.");
    }
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }

    signaling.send("ice-candidate", {
      candidate: event.candidate,
    });
  };

  pc.oniceconnectionstatechange = () => {
    log(`ICE connection state: ${pc.iceConnectionState}`);
  };

  signaling = new SignalingClient({
    signalingUrl,
    roomId,
    onOpen: () => log("Connected to signaling server."),
    onClose: () => log("Signaling socket closed."),
    onError: () => log("Signaling socket error."),
    onMessage: async (message) => {
      await handleSignalingMessage(message);
    },
  });

  signaling.connect();
}

async function handleSignalingMessage(message) {
  const { type, payload } = message;

  if (type === "joined") {
    role = payload.role;
    log(`Joined room as ${role}.`);

    if (role === "offerer" && payload.peerCount === 2) {
      await createAndSendOffer();
    }
    return;
  }

  if (type === "peer-joined") {
    log("Peer joined the room.");

    if (role === "offerer") {
      await createAndSendOffer();
    }
    return;
  }

  if (type === "peer-left") {
    log("Peer left room.");
    return;
  }

  if (type === "peer-timeout") {
    log(payload.message);
    return;
  }

  if (type === "room-full" || type === "error") {
    log(`Server error: ${payload.message}`);
    return;
  }

  if (type === "offer") {
    const description = payload?.sdp;
    if (!description) {
      return;
    }

    const isStable = pc.signalingState === "stable";
    const offerCollision = makingOffer || !isStable;
    ignoreOffer = role === "offerer" && offerCollision;

    if (ignoreOffer) {
      log("Ignoring offer due to glare (offerer peer).");
      return;
    }

    await pc.setRemoteDescription(description);
    await pc.setLocalDescription(await pc.createAnswer());
    signaling.send("answer", {
      sdp: pc.localDescription,
    });
    log("Received offer and sent answer.");
    return;
  }

  if (type === "answer") {
    const description = payload?.sdp;
    if (!description) {
      return;
    }

    await pc.setRemoteDescription(description);
    log("Received answer.");
    return;
  }

  if (type === "ice-candidate") {
    try {
      if (payload?.candidate) {
        await pc.addIceCandidate(payload.candidate);
      }
    } catch (error) {
      if (!ignoreOffer) {
        log(`Failed to add ICE candidate: ${error.message}`);
      }
    }
  }
}

startButton.addEventListener("click", () => {
  initCall().catch((error) => {
    log(`Startup failed: ${error.message}`);
    startButton.disabled = false;
    isStarted = false;
  });
});
