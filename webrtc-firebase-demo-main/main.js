import './style.css';

// ─── Role + Room ───────────────────────────────────────────────────────────
let myRole = null; // 'caller' | 'answerer'
let roomId = null;

// ─── Socket connection ─────────────────────────────────────────────────────
const socket = io("https://videostreaming-sv2j.onrender.com", {
  transports: ["websocket"],
  reconnectionAttempts: 5
});

socket.on("connect_error", () => console.log("Backend waking up..."));

// ─── HTML elements ─────────────────────────────────────────────────────────
const webcamButton      = document.getElementById('webcamButton');
const webcamVideo       = document.getElementById('webcamVideo');
const callButton        = document.getElementById('callButton');
const callInput         = document.getElementById('callInput');
const answerButton      = document.getElementById('answerButton');
const remoteVideo       = document.getElementById('remoteVideo');
const hangupButton      = document.getElementById('hangupButton');
const toggleMic         = document.getElementById('toggleMic');
const toggleCamera      = document.getElementById('toggleCamera');
const durationDisplay   = document.getElementById('debateDuration');
const startDebateButton = document.getElementById('startDebate');
const endArgumentButton = document.getElementById('endArgument');
const debateStatus      = document.getElementById('debateStatus');
const roundDisplay      = document.getElementById('roundDisplay');
const phaseTimer        = document.getElementById('phaseTimer');
const localTranscriptContent  = document.getElementById('localTranscriptContent');
const remoteTranscriptContent = document.getElementById('remoteTranscriptContent');

// ─── ICE servers ───────────────────────────────────────────────────────────
const servers = {
  iceServers: [
    { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }
  ],
  iceCandidatePoolSize: 10
};

// ─── Peer connection ───────────────────────────────────────────────────────
const pc = new RTCPeerConnection(servers);
let localStream = null;
let remoteStream = null;

// ─── WebRTC signaling via Socket.IO ───────────────────────────────────────

// Caller: room created → show ID to share
socket.on("room:created", (id) => {
  roomId = id;
  callInput.value = id;
  console.log("Room created:", id);
});

socket.on("room:error", (msg) => {
  alert(msg);
});

// Caller: answerer has joined → send offer
socket.on("peer:joined", async () => {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("webrtc:offer", offer);
});

// Answerer: received offer → send answer
socket.on("webrtc:offer", async (offer) => {
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit("webrtc:answer", answer);
});

// Caller: received answer
socket.on("webrtc:answer", async (answer) => {
  if (!pc.currentRemoteDescription) {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  }
});

// Both: relay ICE candidates
pc.onicecandidate = (event) => {
  if (event.candidate) socket.emit("webrtc:ice", event.candidate);
};

socket.on("webrtc:ice", async (candidate) => {
  try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
});

// ─── Connection state ──────────────────────────────────────────────────────
pc.onconnectionstatechange = () => {
  console.log("Connection state:", pc.connectionState);

  if (pc.connectionState === 'connected') {
    startDurationTimer();
    toggleMic.disabled = false;
    toggleCamera.disabled = false;
    startDebateButton.disabled = false;
  }

  if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
    stopDurationTimer();
    cleanupMedia();
    webcamButton.disabled = false;
    callButton.disabled = true;
    answerButton.disabled = true;
    hangupButton.disabled = true;
    toggleMic.disabled = true;
    toggleCamera.disabled = true;
    startDebateButton.disabled = true;
  }
};

// ─── Start webcam ──────────────────────────────────────────────────────────
webcamButton.onclick = async () => {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  remoteStream = new MediaStream();

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
  };

  webcamVideo.srcObject = localStream;
  remoteVideo.srcObject = remoteStream;

  callButton.disabled = false;
  answerButton.disabled = false;
  webcamButton.disabled = true;
  toggleMic.disabled = false;
  toggleCamera.disabled = false;
};

// ─── Create call (Speaker 1) ───────────────────────────────────────────────
callButton.onclick = () => {
  myRole = 'caller';
  socket.emit("create:room");
  hangupButton.disabled = false;
};

// ─── Answer call (Speaker 2) ───────────────────────────────────────────────
answerButton.onclick = () => {
  const id = callInput.value.trim().toUpperCase();
  if (!id) { alert("Enter a room ID first"); return; }
  myRole = 'answerer';
  roomId = id;
  socket.emit("join:room", id);
  hangupButton.disabled = false;
};

// ─── Hangup ────────────────────────────────────────────────────────────────
hangupButton.onclick = () => {
  const mySpeaker = myRole === 'caller' ? 'speaker1' : 'speaker2';
  stopTurnRecording(mySpeaker, debateState.round);
  cleanupMedia();
  pc.close();
  callInput.value = '';
  webcamButton.disabled = false;
  callButton.disabled = true;
  answerButton.disabled = true;
  hangupButton.disabled = true;
};

// ─── Cleanup ───────────────────────────────────────────────────────────────
function cleanupMedia() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (remoteStream) { remoteStream.getTracks().forEach(t => t.stop()); remoteStream = null; }
  webcamVideo.srcObject = null;
  remoteVideo.srcObject = null;
}

// ─── Mic / Camera toggles ──────────────────────────────────────────────────
toggleMic.onclick = () => {
  if (!localStream) return;
  const t = localStream.getAudioTracks()[0];
  t.enabled = !t.enabled;
  toggleMic.textContent = t.enabled ? '🎙️ Mute' : '🔇 Unmute';
};

toggleCamera.onclick = () => {
  if (!localStream) return;
  const t = localStream.getVideoTracks()[0];
  t.enabled = !t.enabled;
  toggleCamera.textContent = t.enabled ? '📷 Hide Camera' : '📷 Show Camera';
};

// ─── Duration timer ────────────────────────────────────────────────────────
let durationInterval = null;
let durationSeconds = 0;

function startDurationTimer() {
  durationSeconds = 0;
  durationInterval = setInterval(() => {
    durationSeconds++;
    const m = String(Math.floor(durationSeconds / 60)).padStart(2, '0');
    const s = String(durationSeconds % 60).padStart(2, '0');
    durationDisplay.textContent = `Duration: ${m}:${s}`;
  }, 1000);
}

function stopDurationTimer() {
  clearInterval(durationInterval);
  durationSeconds = 0;
  durationDisplay.textContent = 'Duration: 00:00';
}

// ─── Transcript display ────────────────────────────────────────────────────
socket.on("transcript", ({ speaker, round, text }) => {
  const entry = document.createElement('p');
  entry.style.marginBottom = '0.4rem';
  entry.innerHTML = `<strong>[R${round}]</strong> ${text}`;

  const isMe =
    (myRole === 'caller'   && speaker === 'speaker1') ||
    (myRole === 'answerer' && speaker === 'speaker2');

  const box = isMe ? localTranscriptContent : remoteTranscriptContent;
  if (box.textContent.includes('Transcript will appear')) box.textContent = '';
  box.appendChild(entry);
  box.scrollTop = box.scrollHeight;
});


// ═══════════════════════════════════════════════════════════════════════════
// DEBATE LOGIC
// ═══════════════════════════════════════════════════════════════════════════

const TOTAL_ROUNDS   = 5;
const SPEAK_TIME     = 60;
const FREE_TALK_TIME = 60;
const DELAY_TIME     = 10;
const BREAK_TIME     = 5;

let debateState = {
  active: false,
  round: 0,
  phase: 'idle',
  timer: null,
  secondsLeft: 0,
};

let turnRecorder = null;

// ─── Mic control ───────────────────────────────────────────────────────────
function setMic(enabled) {
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => t.enabled = enabled);
}

// ─── UI helpers ────────────────────────────────────────────────────────────
function updateStatus(text) { debateStatus.textContent = text; }

function updatePhaseTimer(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  phaseTimer.textContent = `${m}:${s}`;
}

function clearDebateTimer() {
  if (debateState.timer) clearInterval(debateState.timer);
}

function startCountdown(seconds, onTick, onDone) {
  clearDebateTimer();
  debateState.secondsLeft = seconds;
  onTick(seconds);
  debateState.timer = setInterval(() => {
    debateState.secondsLeft--;
    onTick(debateState.secondsLeft);
    if (debateState.secondsLeft <= 0) {
      clearDebateTimer();
      onDone();
    }
  }, 1000);
}

// ─── applyPhase: update UI + mic ──────────────────────────────────────────
function applyPhase(phase, round) {
  debateState.phase = phase;
  debateState.round = round;

  if (round > 0) roundDisplay.textContent = `Round ${round} / ${TOTAL_ROUNDS}`;

  switch (phase) {
    case 'freetalk':
      setMic(true);
      updateStatus('🗣️ Free talk — both can speak');
      endArgumentButton.disabled = true;
      break;
    case 'speaker1':
      setMic(myRole === 'caller');
      updateStatus('🎙️ Speaker 1 is arguing...');
      endArgumentButton.disabled = myRole !== 'caller';
      break;
    case 'delay':
      setMic(true);
      updateStatus('⏳ Delay — both can speak freely');
      endArgumentButton.disabled = true;
      break;
    case 'speaker2':
      setMic(myRole === 'answerer');
      updateStatus('🎙️ Speaker 2 is arguing...');
      endArgumentButton.disabled = true;
      break;
    case 'break':
      setMic(false);
      updateStatus(`⏸️ End of Round ${round} — short break`);
      roundDisplay.textContent = `Round ${round} / ${TOTAL_ROUNDS} — Break`;
      endArgumentButton.disabled = true;
      break;
    case 'over':
      setMic(true);
      updateStatus('🏁 Debate Over');
      roundDisplay.textContent = '';
      phaseTimer.textContent = '';
      endArgumentButton.disabled = true;
      startDebateButton.disabled = true;
      break;
  }
}

// ─── Answerer mirrors phase from caller via Socket.IO ─────────────────────
socket.on("debate:phase", ({ phase, round, secondsLeft }) => {
  if (myRole !== 'answerer') return;

  const prevPhase = debateState.phase;
  applyPhase(phase, round);

  // Answerer starts/stops recording
  if (phase === 'speaker2' && prevPhase !== 'speaker2') {
    startTurnRecording('speaker2', round);
  }
  if (prevPhase === 'speaker2' && phase !== 'speaker2') {
    stopTurnRecording('speaker2', round);
  }

  // Mirror the countdown
  if (secondsLeft > 0) startCountdown(secondsLeft, updatePhaseTimer, () => {});
});

// ─── Broadcast phase to answerer ──────────────────────────────────────────
function broadcastPhase(phase, round, secondsLeft) {
  if (myRole !== 'caller') return;
  socket.emit('debate:phase', { phase, round, secondsLeft });
}

// ─── Turn recorder ─────────────────────────────────────────────────────────
function startTurnRecording(speaker, round) {
  if (!localStream) return;
  const audioStream = new MediaStream(localStream.getAudioTracks());
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus' : 'audio/webm';

  turnRecorder = new MediaRecorder(audioStream, { mimeType });
  turnRecorder.ondataavailable = (event) => {
    if (event.data?.size > 0) {
      event.data.arrayBuffer().then(buf => {
        socket.emit('audio:chunk', { speaker, round, chunk: buf });
      });
    }
  };
  turnRecorder.start(3000);
  console.log(`🔴 Recording: ${speaker} R${round}`);
}

function stopTurnRecording(speaker, round) {
  if (!turnRecorder || turnRecorder.state === 'inactive') return;
  turnRecorder.stop();
  turnRecorder = null;
  socket.emit('turn:end', { speaker, round });
  console.log(`⏹️ Stopped: ${speaker} R${round}`);
}

// ─── Debate phases (caller drives) ────────────────────────────────────────
function startFreeTalk() {
  applyPhase('freetalk', 0);
  broadcastPhase('freetalk', 0, FREE_TALK_TIME);
  startCountdown(FREE_TALK_TIME, updatePhaseTimer, () => startRound(1));
}

function startRound(round) {
  if (round > TOTAL_ROUNDS) { endDebate(); return; }
  debateState.round = round;
  startSpeaker1Turn();
}

function startSpeaker1Turn() {
  applyPhase('speaker1', debateState.round);
  broadcastPhase('speaker1', debateState.round, SPEAK_TIME);
  startTurnRecording('speaker1', debateState.round);
  startCountdown(SPEAK_TIME, updatePhaseTimer, () => {
    stopTurnRecording('speaker1', debateState.round);
    startDelay();
  });
}

function startDelay() {
  applyPhase('delay', debateState.round);
  broadcastPhase('delay', debateState.round, DELAY_TIME);
  startCountdown(DELAY_TIME, updatePhaseTimer, startSpeaker2Turn);
}

function startSpeaker2Turn() {
  applyPhase('speaker2', debateState.round);
  broadcastPhase('speaker2', debateState.round, SPEAK_TIME);
  startCountdown(SPEAK_TIME, updatePhaseTimer, () => startRoundBreak(debateState.round));
}

function startRoundBreak(round) {
  applyPhase('break', round);
  broadcastPhase('break', round, BREAK_TIME);
  startCountdown(BREAK_TIME, updatePhaseTimer, () => startRound(round + 1));
}

function endDebate() {
  clearDebateTimer();
  debateState.active = false;
  applyPhase('over', debateState.round);
  broadcastPhase('over', debateState.round, 0);
}

// ─── Button handlers ───────────────────────────────────────────────────────
startDebateButton.onclick = () => {
  if (!localStream) { alert('Start your webcam first!'); return; }
  if (myRole !== 'caller') { alert('Only Speaker 1 can start the debate!'); return; }
  debateState.active = true;
  startDebateButton.disabled = true;
  startFreeTalk();
};

endArgumentButton.onclick = () => {
  if (debateState.phase === 'speaker1' && myRole === 'caller') {
    clearDebateTimer();
    stopTurnRecording('speaker1', debateState.round);
    startDelay();
  }
};