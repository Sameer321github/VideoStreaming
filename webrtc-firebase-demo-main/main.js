import './style.css';
import firebase from 'firebase/app';
import 'firebase/firestore';

let mediaRecorder;
let recordedChunks = [];

// Socket connection (for backend wake detection / future use)
const socket = io("https://videostreaming-sv2j.onrender.com", {
  transports: ["websocket"],
  reconnectionAttempts: 5
});

socket.on("connect_error", () => {
  console.log("Backend waking up...");
});


// Firebase config
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


// ICE servers
const servers = {
  iceServers: [
    { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }
  ],
  iceCandidatePoolSize: 10
};


// Peer connection
const pc = new RTCPeerConnection(servers);

let localStream = null;
let remoteStream = null;


// HTML elements
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


// Connection state
pc.onconnectionstatechange = () => {

  console.log('Connection state:', pc.connectionState);

  if (pc.connectionState === 'connected') {
    startRecording();
    startDurationTimer();
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
  }
};



// Start webcam
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
};


// Create call
callButton.onclick = async () => {

  const callDoc = firestore.collection('calls').doc();
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


// Answer call
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

        pc.addIceCandidate(
          new RTCIceCandidate(change.doc.data())
        );

      }

    });

  });

};



// Hangup
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


// Cleanup media
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



// Recording
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



// Mic toggle
toggleMic.onclick = () => {

  if (!localStream) return;

  const audioTrack = localStream.getAudioTracks()[0];

  audioTrack.enabled = !audioTrack.enabled;

  toggleMic.textContent =
    audioTrack.enabled ? '🎙️ Mute' : '🔇 Unmute';

};


// Camera toggle
toggleCamera.onclick = () => {

  if (!localStream) return;

  const videoTrack = localStream.getVideoTracks()[0];

  videoTrack.enabled = !videoTrack.enabled;

  toggleCamera.textContent =
    videoTrack.enabled ? '📷 Hide Camera' : '📷 Show Camera';

};


// Debate timer
let durationInterval = null;
let durationSeconds = 0;

function startDurationTimer() {

  durationSeconds = 0;

  durationInterval = setInterval(() => {

    durationSeconds++;

    const mins = String(Math.floor(durationSeconds / 60)).padStart(2,'0');
    const secs = String(durationSeconds % 60).padStart(2,'0');

    durationDisplay.textContent = `Duration: ${mins}:${secs}`;

  },1000);

}

function stopDurationTimer() {

  clearInterval(durationInterval);
  durationSeconds = 0;

  durationDisplay.textContent = 'Duration: 00:00';

}