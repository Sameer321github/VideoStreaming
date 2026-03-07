import './style.css';
import firebase from 'firebase/app';
import 'firebase/firestore';

let mediaRecorder;
let recordedChunks = [];

// ─── Socket connection ─────────────────────────────────────────────────────
  const socket = io(import.meta.env.VITE_BACKEND_URL, {
  transports: ["websocket"],
  reconnectionAttempts: 5
});

socket.on("connect_error", () => {
  console.log("Backend waking up...");
});

// ─── Transcript display ────────────────────────────────────────────────────
const localTranscriptContent = document.getElementById('localTranscriptContent');
const remoteTranscriptContent = document.getElementById('remoteTranscriptContent');

// Listen for transcripts from server
socket.on("transcript", ({ speaker, round, text }) => {
  const entry = document.createElement('p');
  entry.style.marginBottom = '0.4rem';
  entry.innerHTML = `<strong>[R${round}]</strong> ${text}`;

  if (speaker === 'speaker1') {
    // Remove placeholder if still there
    if (localTranscriptContent.textContent.includes('Transcript will appear')) {
      localTranscriptContent.textContent = '';
    }
    localTranscriptContent.appendChild(entry);
    localTranscriptContent.scrollTop = localTranscriptContent.scrollHeight;
  } else {
    if (remoteTranscriptContent.textContent.includes('Transcript will appear')) {
      remoteTranscriptContent.textContent = '';
    }
    remoteTranscriptContent.appendChild(entry);
    remoteTranscriptContent.scrollTop = remoteTranscriptContent.scrollHeight;
  }
});


// ─── Firebase config ───────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyC0nPFeOfMAr4FochRiBOTeq7eM8G-72IY",
  authDomain: "webrtc-322c9.firebaseapp.com",
  projectId: "webrtc-322c9",
  storageBucket: "webrtc-322c9.firebasestorage.app",
  messagingSenderId: "761157747730",
  appId: "1:761157747730:web:a6182da3e3a986524404cb",
  measurementId: "G-VCQ5NY9V1G"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const firestore = firebase.firestore();


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


// ─── HTML elements ─────────────────────────────────────────────────────────
const webcamButton = document.getElementById('webcamButton');
const webcamVideo = document.getElementById('webcamVideo');
const callButton = document.getElementById('callButton');
const callInput = document.getElementById('callInput');
const answerButton = document.getElementById('answerButton');
const remoteVideo = document.getElementById('remoteVideo');
const hangupButton = document.getElementById('hangupButton');

const toggleMic = document.getElementById('toggleMic');
const toggleCamera = document.getElementById('toggleCamera');
const durationDisplay = document.getElementById('debateDuration');


// ─── Connection state ──────────────────────────────────────────────────────
pc.onconnectionstatechange = () => {
  console.log('Connection state:', pc.connectionState);

  if (pc.connectionState === 'connected') {
    startRecording();
    startDurationTimer();

    // Enable controls now that connection is live
    toggleMic.disabled = false;
    toggleCamera.disabled = false;
    startDebateButton.disabled = false;
  }

  if (
    pc.connectionState === 'disconnected' ||
    pc.connectionState === 'failed' ||
    pc.connectionState === 'closed'
  ) {
    stopRecording();
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
  localStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true
  });

  remoteStream = new MediaStream();

  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach(track => {
      remoteStream.addTrack(track);
    });
  };

  webcamVideo.srcObject = localStream;
  remoteVideo.srcObject = remoteStream;

  callButton.disabled = false;
  answerButton.disabled = false;
  webcamButton.disabled = true;

  // Enable mic/camera controls immediately after webcam starts
  toggleMic.disabled = false;
  toggleCamera.disabled = false;
};


// ─── Create call ───────────────────────────────────────────────────────────
callButton.onclick = async () => {
  const randomId = Math.random().toString(36).substring(2, 7).toUpperCase();
  const callDoc = firestore.collection('calls').doc(randomId);
  const offerCandidates = callDoc.collection('offerCandidates');
  const answerCandidates = callDoc.collection('answerCandidates');

  callInput.value = callDoc.id;

  pc.onicecandidate = event => {
    event.candidate && offerCandidates.add(event.candidate.toJSON());
  };

  const offerDescription = await pc.createOffer();
  await pc.setLocalDescription(offerDescription);

  await callDoc.set({
    offer: {
      sdp: offerDescription.sdp,
      type: offerDescription.type
    }
  });

  callDoc.onSnapshot(snapshot => {
    const data = snapshot.data();
    if (!pc.currentRemoteDescription && data?.answer) {
      const answerDescription = new RTCSessionDescription(data.answer);
      pc.setRemoteDescription(answerDescription);
    }
  });

  answerCandidates.onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
      if (change.type === 'added') {
        const candidate = new RTCIceCandidate(change.doc.data());
        pc.addIceCandidate(candidate);
      }
    });
  });

  hangupButton.disabled = false;
};


// ─── Answer call ───────────────────────────────────────────────────────────
answerButton.onclick = async () => {
  const callId = callInput.value;
  const callDoc = firestore.collection('calls').doc(callId);
  const answerCandidates = callDoc.collection('answerCandidates');
  const offerCandidates = callDoc.collection('offerCandidates');

  pc.onicecandidate = event => {
    event.candidate && answerCandidates.add(event.candidate.toJSON());
  };

  const callData = (await callDoc.get()).data();

  await pc.setRemoteDescription(
    new RTCSessionDescription(callData.offer)
  );

  const answerDescription = await pc.createAnswer();
  await pc.setLocalDescription(answerDescription);

  await callDoc.update({
    answer: {
      type: answerDescription.type,
      sdp: answerDescription.sdp
    }
  });

  offerCandidates.onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
      if (change.type === 'added') {
        pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
      }
    });
  });
};


// ─── Hangup ────────────────────────────────────────────────────────────────
hangupButton.onclick = () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  cleanupMedia();
  pc.close();

  callInput.value = '';

  webcamButton.disabled = false;
  callButton.disabled = true;
  answerButton.disabled = true;
  hangupButton.disabled = true;
};


// ─── Cleanup media ─────────────────────────────────────────────────────────
function cleanupMedia() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  if (remoteStream) {
    remoteStream.getTracks().forEach(track => track.stop());
    remoteStream = null;
  }
  webcamVideo.srcObject = null;
  remoteVideo.srcObject = null;
}


// ─── Full-session recording (unchanged from before) ────────────────────────
function startRecording() {
  if (!localStream) return;
  const audioStream = new MediaStream(localStream.getAudioTracks());
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(audioStream);
  mediaRecorder.ondataavailable = event => {
    if (event.data.size > 0) recordedChunks.push(event.data);
  };
  mediaRecorder.onstop = saveRecording;
  mediaRecorder.start(3000);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function saveRecording() {
  const blob = new Blob(recordedChunks, { type: 'audio/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'speaker-recording.webm';
  a.click();
}


// ─── Mic toggle ────────────────────────────────────────────────────────────
toggleMic.onclick = () => {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  audioTrack.enabled = !audioTrack.enabled;
  toggleMic.textContent = audioTrack.enabled ? '🎙️ Mute' : '🔇 Unmute';
};

// ─── Camera toggle ─────────────────────────────────────────────────────────
toggleCamera.onclick = () => {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  videoTrack.enabled = !videoTrack.enabled;
  toggleCamera.textContent = videoTrack.enabled ? '📷 Hide Camera' : '📷 Show Camera';
};


// ─── Debate duration timer ─────────────────────────────────────────────────
let durationInterval = null;
let durationSeconds = 0;

function startDurationTimer() {
  durationSeconds = 0;
  durationInterval = setInterval(() => {
    durationSeconds++;
    const mins = String(Math.floor(durationSeconds / 60)).padStart(2, '0');
    const secs = String(durationSeconds % 60).padStart(2, '0');
    durationDisplay.textContent = `Duration: ${mins}:${secs}`;
  }, 1000);
}

function stopDurationTimer() {
  clearInterval(durationInterval);
  durationSeconds = 0;
  durationDisplay.textContent = 'Duration: 00:00';
}


// ═══════════════════════════════════════════════════════════════════════════
// DEBATE LOGIC + AUDIO STREAMING
// ═══════════════════════════════════════════════════════════════════════════

const TOTAL_ROUNDS = 5;
const SPEAK_TIME = 60;
const FREE_TALK_TIME = 60;
const DELAY_TIME = 10;

let debateState = {
  active: false,
  round: 0,
  phase: 'idle', // idle | freetalk | speaker1 | delay | speaker2 | over
  timer: null,
  secondsLeft: 0,
};

// Per-turn MediaRecorder for streaming to server
let turnRecorder = null;

const startDebateButton = document.getElementById('startDebate');
const endArgumentButton = document.getElementById('endArgument');
const debateStatus = document.getElementById('debateStatus');
const roundDisplay = document.getElementById('roundDisplay');
const phaseTimer = document.getElementById('phaseTimer');


// ─── Mic control ───────────────────────────────────────────────────────────
function setMic(stream, enabled) {
  if (!stream) return;
  stream.getAudioTracks().forEach(t => t.enabled = enabled);
}


// ─── UI helpers ────────────────────────────────────────────────────────────
function updateStatus(text) {
  debateStatus.textContent = text;
}

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


// ─── Turn recorder helpers ─────────────────────────────────────────────────

/**
 * Start capturing local mic audio and streaming chunks to server.
 * @param {string} speaker  "speaker1" or "speaker2"
 * @param {number} round
 */
function startTurnRecording(speaker, round) {
  if (!localStream) return;

  // Only record local audio when it's speaker1's turn (we are speaker1)
  // Speaker2's audio comes from remoteStream — handled server-side via peer if needed
  // For now we only transcribe the local user's turns
  if (speaker !== 'speaker1') return;

  const audioStream = new MediaStream(localStream.getAudioTracks());

  // Pick best supported format
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  turnRecorder = new MediaRecorder(audioStream, { mimeType });

  turnRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      event.data.arrayBuffer().then(buffer => {
        socket.emit('audio:chunk', {
          speaker,
          round,
          chunk: buffer,
        });
      });
    }
  };

  turnRecorder.start(3000); // emit every 3 seconds
  console.log(`🔴 Turn recording started: ${speaker} R${round}`);
}

/**
 * Stop the turn recorder and notify server the turn is over.
 * @param {string} speaker
 * @param {number} round
 */
function stopTurnRecording(speaker, round) {
  if (speaker !== 'speaker1') return;
  if (!turnRecorder || turnRecorder.state === 'inactive') return;

  turnRecorder.stop();
  turnRecorder = null;

  // Tell server to transcribe what it buffered
  socket.emit('turn:end', { speaker, round });
  console.log(`⏹️ Turn recording stopped: ${speaker} R${round}`);
}


// ─── Debate phases ─────────────────────────────────────────────────────────

function startFreeTalk() {
  debateState.phase = 'freetalk';
  setMic(localStream, true);
  updateStatus('🗣️ Free talk — both can speak');
  endArgumentButton.disabled = true;
  startCountdown(FREE_TALK_TIME, updatePhaseTimer, () => startRound(1));
}

function startRound(round) {
  if (round > TOTAL_ROUNDS) {
    endDebate();
    return;
  }
  debateState.round = round;
  roundDisplay.textContent = `Round ${round} / ${TOTAL_ROUNDS}`;
  startSpeaker1Turn();
}

function startSpeaker1Turn() {
  debateState.phase = 'speaker1';
  setMic(localStream, true);
  updateStatus('🎙️ Speaker 1 is arguing...');
  endArgumentButton.disabled = false;

  startTurnRecording('speaker1', debateState.round);

  startCountdown(SPEAK_TIME, updatePhaseTimer, () => {
    stopTurnRecording('speaker1', debateState.round);
    startDelay();
  });
}

function startDelay() {
  debateState.phase = 'delay';
  setMic(localStream, true);
  endArgumentButton.disabled = true;
  updateStatus('⏳ Delay — both can speak freely');
  startCountdown(DELAY_TIME, updatePhaseTimer, startSpeaker2Turn);
}

function startSpeaker2Turn() {
  debateState.phase = 'speaker2';
  setMic(localStream, false); // mute local (speaker1) during speaker2's turn
  updateStatus('🎙️ Speaker 2 is arguing...');
  endArgumentButton.disabled = true;

  // NOTE: Speaker 2 transcription would require capturing remoteStream audio.
  // This is a known limitation — browser security prevents direct remoteStream
  // MediaRecorder in most setups. A future improvement would route audio
  // through the server via WebRTC data channels or a TURN relay.

  startCountdown(SPEAK_TIME, updatePhaseTimer, () => {
    setMic(localStream, true);
    startRound(debateState.round + 1);
  });
}

function endDebate() {
  clearDebateTimer();
  debateState.phase = 'over';
  debateState.active = false;
  setMic(localStream, true);
  updateStatus('🏁 Debate Over');
  roundDisplay.textContent = '';
  phaseTimer.textContent = '';
  endArgumentButton.disabled = true;
  startDebateButton.disabled = true;
}


// ─── Button handlers ───────────────────────────────────────────────────────

startDebateButton.onclick = () => {
  if (!localStream) {
    alert('Start your webcam first!');
    return;
  }
  debateState.active = true;
  startDebateButton.disabled = true;
  startFreeTalk();
};

endArgumentButton.onclick = () => {
  if (debateState.phase === 'speaker1') {
    clearDebateTimer();
    stopTurnRecording('speaker1', debateState.round);
    startDelay();
  }
};