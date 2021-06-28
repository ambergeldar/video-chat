/* The `dotenv` package allows us to load environment
 * variables from the `.env` file. Then, we can access them
 * with `process.env.ENV_VAR_NAME`.
 */
require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const DG_KEY = process.env.DG_KEY;

if (DG_KEY === undefined) {
  throw "You must define DG_KEY in your .env file";
}

const app = express();
let server = http.createServer(app);

/*
 * Basic configuration:
 * - we expose the `/public` folder as a "static" folder, so the
 *   browser can directly request the js and css files that it contains.
 * - we send the `/public/index.html` file when the browser requests
 *   any route.
 */
app.use(express.static(__dirname + "/public"));
app.get("*", function (req, res) {
  res.sendFile(`${__dirname}/public/index.html`);
});

const SocketIoServer = require("socket.io").Server;
const Socket = require("socket.io").Socket;
const io = new SocketIoServer(server);
io.sockets.on("connection", handle_connection);

const MAX_CLIENTS = 2;
/**
 * This function will be called every time a client
 * opens a socket with the server. This is where we will define
 * what to do in reaction to messages sent by clients.
 * @param {Socket} socket */
function handle_connection(socket) {
  const rooms = io.of("/").adapter.rooms;

  socket.on("join", (room) => {
    /**
     *  The `room` parameter comes from the client. Here is a possible user story:
     * - Alice wants to open a new room, so she generates a random string (for example, "AWSMDG"),
     *   which will serve as a room identifier. She sends a `join` message with "AWSMDG" as a
     *   parameter; this opens the room and sends the identifier to Bob,
     * - To join the room, Bob must send the same `join` message with "AWSMDG" as a parameter.
     */

    let clientsCount = 0;
    if (rooms[room]) {
      clientsCount = rooms[room].length;
    }
    if (clientsCount >= MAX_CLIENTS) {
      socket.emit("full", room);
    } else {
      socket.join(room);
      socket.broadcast.to(room).emit("user-joined", socket.id);

      setupWebRTCSignaling(socket);
      setupRealtimeTranscription(socket, room);

      socket.on("disconnect", () => {
        socket.broadcast.to(room).emit("bye", socket.id);
      });
    }
  });
}

/**
 * @param {Socket} socket
 * @param {string} room
 */
function setupRealtimeTranscription(socket, room) {
  /** The sampleRate must match what the client uses. */
  const sampleRate = 16000;
  /**
   * We connect a Websocket to Deepgram's server. You can add options as parameters in the URL. To learn more, see the docs:
   * https://developers.deepgram.com/api-reference/deepgram-api#operation/transcribeStreamingAudio
   */
  const dgSocket = new WebSocket(
    "wss://dev.brain.deepgram.com:8090/v1/listen/stream?encoding=ogg-opus&sample_rate=" +
      sampleRate +
      "&punctuate=true",
    {
      headers: {
        Authorization: "token " + DG_KEY,
      },
    }
  );

  /** We must receive the very first audio packet from the client because
   * it contains some header data needed for audio decoding.
   *
   * Thus, we send a message to the client when the socket to Deepgram is ready,
   * so the client knows it can start sending audio data.
   */
  dgSocket.addEventListener("open", () => socket.emit("can-open-mic"));

  /**
   * We forward the audio stream from the client's microphone to Deepgram's server.
   */
  socket.on("microphone-stream", (stream) => {
    if (dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.send(stream);
    }
  });

  /** On Deepgram's server message, we forward the response back to all the
   * clients in the room.
   */
  dgSocket.addEventListener("message", (event) => {
    io.to(room).emit("transcript-result", socket.id, JSON.parse(event.data));
  });

  /** We close the dsSocket when the client disconnects. */
  socket.on("disconnect", () => {
    if (dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.send(new Uint8Array(0));
    }
    dgSocket.close();
  });
}

/**
 * Handle the WebRTC "signaling". This means we forward all the needed data from
 * Alice to Bob to establish a peer-to-peer connection. Once the peer-to-peer 
 * connection is established, the video stream won't go through the server.
 *
 * @param {Socket} socket
 */
function setupWebRTCSignaling(socket) {
  socket.on("video-offer", (id, message) => {
    socket.to(id).emit("video-offer", socket.id, message);
  });
  socket.on("video-answer", (id, message) => {
    socket.to(id).emit("video-answer", socket.id, message);
  });
  socket.on("ice-candidate", (id, message) => {
    socket.to(id).emit("ice-candidate", socket.id, message);
  });
}

const listener = server.listen(process.env.PORT, () =>
  console.log(`Server is running on port ${process.env.PORT}`)
);
