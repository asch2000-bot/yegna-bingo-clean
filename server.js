const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"]
});

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Health check for Render
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ========== DATA FILES ==========
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const usersFile = path.join(dataDir, "users.json");
const gamesFile = path.join(dataDir, "games.json");
const depositsFile = path.join(dataDir, "deposits.json");

if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, "{}");
if (!fs.existsSync(gamesFile)) fs.writeFileSync(gamesFile, "{}");
if (!fs.existsSync(depositsFile)) fs.writeFileSync(depositsFile, "[]");

let users = {};
let games = {};
let deposits = [];

function loadUsers() { try { users = JSON.parse(fs.readFileSync(usersFile)); } catch(e) { users = {}; } }
function loadGames() { try { games = JSON.parse(fs.readFileSync(gamesFile)); } catch(e) { games = {}; } }
function loadDeposits() { try { deposits = JSON.parse(fs.readFileSync(depositsFile)); } catch(e) { deposits = []; } }
function saveUsers() { fs.writeFileSync(usersFile, JSON.stringify(users, null, 2)); }
function saveGames() { fs.writeFileSync(gamesFile, JSON.stringify(games, null, 2)); }
function saveDeposits() { fs.writeFileSync(depositsFile, JSON.stringify(deposits, null, 2)); }

loadUsers(); loadGames(); loadDeposits();

// ========== BINGO CARD & WIN LOGIC ==========
function generateBingoCard() {
  const card = [];
  const ranges = [[1,15], [16,30], [31,45], [46,60], [61,75]];
  for (let col = 0; col < 5; col++) {
    const numbers = new Set();
    const [min, max] = ranges[col];
    while (numbers.size < 5) {
      numbers.add(Math.floor(Math.random() * (max - min + 1)) + min);
    }
    const sorted = Array.from(numbers).sort((a,b) => a-b);
    for (let row = 0; row < 5; row++) {
      if (!card[row]) card[row] = [];
      card[row][col] = { value: sorted[row], marked: false };
    }
  }
  card[2][2].marked = true;
  card[2][2].value = "FREE";
  return card;
}

function isWinningCard(card) {
  for (let i = 0; i < 5; i++) if (card[i].every(c => c.marked)) return true;
  for (let j = 0; j < 5; j++) {
    let col = true;
    for (let i = 0; i < 5; i++) if (!card[i][j].marked) col = false;
    if (col) return true;
  }
  let diag1 = true, diag2 = true;
  for (let i = 0; i < 5; i++) {
    if (!card[i][i].marked) diag1 = false;
    if (!card[i][4-i].marked) diag2 = false;
  }
  if (diag1 || diag2) return true;
  if (card[0][0].marked && card[0][4].marked && card[4][0].marked && card[4][4].marked) return true;
  return false;
}

class BingoGame {
  constructor(gameId, hostId, hostName) {
    this.id = gameId;
    this.hostId = hostId;
    this.hostName = hostName;
    this.players = [];
    this.status = "waiting";
    this.calledNumbers = [];
    this.currentNumber = null;
    this.winner = null;
    this.potAmount = 0;
    this.numberInterval = null;
  }
  addPlayer(playerId, playerName, numCards, betPerCard) {
    if (this.status !== "waiting") return false;
    if (numCards < 1 || numCards > 3) return false;
    if (![10,20,50,100].includes(betPerCard)) return false;
    if (this.players.find(p => p.id === playerId)) return false;
    const cards = [];
    for (let i = 0; i < numCards; i++) cards.push(generateBingoCard());
    const totalBet = numCards * betPerCard;
    this.players.push({ id: playerId, name: playerName, cards, totalBet, hasWon: false });
    this.potAmount += totalBet;
    return true;
  }
  markNumber(number) {
    for (let player of this.players)
      for (let card of player.cards)
        for (let row of card)
          for (let cell of row)
            if (cell.value === number && !cell.marked) cell.marked = true;
  }
  checkWinner() {
    for (let player of this.players) {
      if (player.hasWon) continue;
      for (let card of player.cards) {
        if (isWinningCard(card)) {
          player.hasWon = true;
          this.winner = player;
          this.status = "finished";
          if (this.numberInterval) clearInterval(this.numberInterval);
          return player;
        }
      }
    }
    return null;
  }
  callNumber() {
    if (this.status !== "active") return null;
    const available = [];
    for (let i = 1; i <= 75; i++) if (!this.calledNumbers.includes(i)) available.push(i);
    if (available.length === 0) { this.status = "finished"; return null; }
    const number = available[Math.floor(Math.random() * available.length)];
    this.calledNumbers.push(number);
    this.currentNumber = number;
    this.markNumber(number);
    const winner = this.checkWinner();
    return { number, winner };
  }
  startGame() {
    if (this.status !== "waiting") return false;
    if (this.players.length < 2) return false;
    this.status = "active";
    this.numberInterval = setInterval(() => {
      if (this.status === "active") {
        const result = this.callNumber();
        if (result && result.winner) {
          const prize = Math.floor(this.potAmount * 0.8);
          const winnerUser = users[result.winner.id];
          if (winnerUser) { winnerUser.balance += prize; winnerUser.gamesWon = (winnerUser.gamesWon || 0) + 1; saveUsers(); }
          io.to(this.id).emit("gameEnded", { winner: result.winner.name, prize });
          io.to(this.id).emit("gameState", this.getState());
        } else if (result && result.number) {
          io.to(this.id).emit("numberCalled", { number: result.number });
          io.to(this.id).emit("gameState", this.getState());
        }
      }
    }, 4000);
    return true;
  }
  getState() {
    return {
      id: this.id,
      status: this.status,
      players: this.players.map(p => ({ id: p.id, name: p.name, cards: p.cards, totalBet: p.totalBet, hasWon: p.hasWon })),
      calledNumbers: this.calledNumbers,
      currentNumber: this.currentNumber,
      winner: this.winner,
      potAmount: this.potAmount
    };
  }
}

// ========== API ROUTES ==========
app.post("/api/register", (req, res) => {
  const { phone, name } = req.body;
  loadUsers();
  let existing = Object.values(users).find(u => u.phone === phone);
  if (existing) {
    res.json({ success: true, userId: existing.id, balance: existing.balance });
  } else {
    const userId = Date.now().toString() + Math.random().toString(36).substr(2, 6);
    users[userId] = { id: userId, name, phone, balance: 0, gamesPlayed: 0, gamesWon: 0, registeredAt: Date.now() };
    saveUsers();
    res.json({ success: true, userId, balance: 0 });
  }
});

app.get("/api/user/:userId", (req, res) => {
  loadUsers();
  res.json(users[req.params.userId] || null);
});

app.post("/api/deposit/request", (req, res) => {
  const { userId, amount, transactionText } = req.body;
  loadDeposits();
  const deposit = { id: Date.now().toString() + Math.random().toString(36).substr(2, 6), userId, amount, transactionText, status: "pending", createdAt: Date.now() };
  deposits.push(deposit);
  saveDeposits();
  res.json({ success: true, depositId: deposit.id });
});

app.post("/api/deposit/approve", (req, res) => {
  const { depositId } = req.body;
  loadDeposits(); loadUsers();
  const deposit = deposits.find(d => d.id === depositId);
  if (deposit && deposit.status === "pending") {
    deposit.status = "approved";
    const user = users[deposit.userId];
    if (user) user.balance += deposit.amount;
    saveUsers(); saveDeposits();
    res.json({ success: true });
  } else res.json({ error: "Deposit not found" });
});

app.get("/api/games", (req, res) => {
  loadGames();
  const activeGames = Object.values(games).filter(g => g.status === "waiting");
  res.json(activeGames.map(g => ({ id: g.id, hostName: g.hostName, playerCount: g.players.length })));
});

app.post("/api/game/create", (req, res) => {
  const { hostId, hostName } = req.body;
  loadGames();
  const gameId = Math.random().toString(36).substr(2, 6).toUpperCase();
  games[gameId] = new BingoGame(gameId, hostId, hostName);
  saveGames();
  res.json({ success: true, gameId });
});

app.post("/api/game/join", (req, res) => {
  const { gameId, playerId, playerName, numCards, betPerCard } = req.body;
  loadGames(); loadUsers();
  const game = games[gameId];
  if (!game) return res.json({ error: "Game not found" });
  if (game.status !== "waiting") return res.json({ error: "Game already started" });
  const user = users[playerId];
  const totalCost = numCards * betPerCard;
  if (!user || user.balance < totalCost) return res.json({ error: "Insufficient balance" });
  if (game.addPlayer(playerId, playerName, numCards, betPerCard)) {
    user.balance -= totalCost;
    user.gamesPlayed++;
    saveUsers(); saveGames();
    res.json({ success: true, newBalance: user.balance });
  } else res.json({ error: "Invalid join request" });
});

app.post("/api/game/start", (req, res) => {
  const { gameId, hostId } = req.body;
  loadGames();
  const game = games[gameId];
  if (!game) return res.json({ error: "Game not found" });
  if (game.hostId !== hostId) return res.json({ error: "Only host can start" });
  const started = game.startGame();
  if (started) { saveGames(); res.json({ success: true }); }
  else res.json({ error: "Need at least 2 players" });
});

app.get("/api/game/:gameId", (req, res) => {
  loadGames();
  const game = games[req.params.gameId];
  game ? res.json(game.getState()) : res.json({ error: "Not found" });
});

// Socket.io
io.on("connection", (socket) => {
  console.log("Player connected");
  socket.on("joinGame", (gameId) => {
    socket.join(gameId);
    const game = games[gameId];
    if (game) socket.emit("gameState", game.getState());
  });
});

// Serve frontend
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// ========== START SERVER ==========
const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
});