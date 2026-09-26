// server/index.ts
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";

// server/rooms.ts
import { randomBytes, randomInt } from "node:crypto";

// src/game/deck/deck.ts
var SUITS = ["s", "h", "d", "c"];
var RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
function createDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit });
  return deck;
}
function shuffle(items, rng) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// src/game/evaluator/evaluator.ts
var CAT = {
  HIGH: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8
};
var SUIT_INDEX = { s: 0, h: 1, d: 2, c: 3 };
var BASE = 16 ** 5;
function pack(cat, ranks) {
  let s = cat * BASE;
  for (let i = 0; i < 5; i++) s += (ranks[i] ?? 0) * 16 ** (4 - i);
  return s;
}
function straightHigh(mask) {
  let m = mask;
  if (m & 1 << 14) m |= 1 << 1;
  for (let high = 14; high >= 5; high--) {
    const need = 31 << high - 4;
    if ((m & need) === need) return high;
  }
  return 0;
}
function topRanksFromMask(mask, n) {
  const out = [];
  for (let r = 14; r >= 2 && out.length < n; r--) if (mask & 1 << r) out.push(r);
  return out;
}
function evaluate(cards) {
  const counts = new Uint8Array(15);
  const suitMask = [0, 0, 0, 0];
  const suitCount = [0, 0, 0, 0];
  let mask = 0;
  for (const c of cards) {
    counts[c.rank]++;
    const si = SUIT_INDEX[c.suit];
    suitMask[si] |= 1 << c.rank;
    suitCount[si]++;
    mask |= 1 << c.rank;
  }
  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (suitCount[s] >= 5) flushSuit = s;
  if (flushSuit >= 0) {
    const sf = straightHigh(suitMask[flushSuit]);
    if (sf) return pack(CAT.STRAIGHT_FLUSH, [sf]);
  }
  const quads = [];
  const trips = [];
  const pairs = [];
  const singles = [];
  for (let r = 14; r >= 2; r--) {
    const n = counts[r];
    if (n === 4) quads.push(r);
    else if (n === 3) trips.push(r);
    else if (n === 2) pairs.push(r);
    else if (n === 1) singles.push(r);
  }
  if (quads.length) {
    const q = quads[0];
    let kicker = 0;
    for (let r = 14; r >= 2; r--) if (r !== q && counts[r] > 0) {
      kicker = r;
      break;
    }
    return pack(CAT.QUADS, [q, kicker]);
  }
  if (trips.length && (trips.length > 1 || pairs.length)) {
    const t = trips[0];
    const p = Math.max(trips[1] ?? 0, pairs[0] ?? 0);
    return pack(CAT.FULL_HOUSE, [t, p]);
  }
  if (flushSuit >= 0) return pack(CAT.FLUSH, topRanksFromMask(suitMask[flushSuit], 5));
  const st = straightHigh(mask);
  if (st) return pack(CAT.STRAIGHT, [st]);
  if (trips.length) return pack(CAT.TRIPS, [trips[0], ...singles.slice(0, 2)]);
  if (pairs.length >= 2) {
    const [p1, p2] = pairs;
    let kicker = 0;
    for (let r = 14; r >= 2; r--) if (r !== p1 && r !== p2 && counts[r] > 0) {
      kicker = r;
      break;
    }
    return pack(CAT.TWO_PAIR, [p1, p2, kicker]);
  }
  if (pairs.length === 1) return pack(CAT.PAIR, [pairs[0], ...singles.slice(0, 3)]);
  return pack(CAT.HIGH, singles.slice(0, 5));
}
function scoreCategory(score) {
  return Math.floor(score / BASE);
}
function scoreRanks(score) {
  const out = [];
  for (let i = 0; i < 5; i++) out.push(Math.floor(score / 16 ** (4 - i)) % 16);
  return out;
}
var RANK_WORD = {
  2: "Two",
  3: "Three",
  4: "Four",
  5: "Five",
  6: "Six",
  7: "Seven",
  8: "Eight",
  9: "Nine",
  10: "Ten",
  11: "Jack",
  12: "Queen",
  13: "King",
  14: "Ace"
};
var RANK_PLURAL = {
  2: "Twos",
  3: "Threes",
  4: "Fours",
  5: "Fives",
  6: "Sixes",
  7: "Sevens",
  8: "Eights",
  9: "Nines",
  10: "Tens",
  11: "Jacks",
  12: "Queens",
  13: "Kings",
  14: "Aces"
};
function describeScore(score) {
  const cat = scoreCategory(score);
  const r = scoreRanks(score);
  switch (cat) {
    case CAT.STRAIGHT_FLUSH:
      if (r[0] === 14) return { name: "Royal Flush", description: "Ten to Ace" };
      return { name: "Straight Flush", description: `${RANK_WORD[r[0]]} high` };
    case CAT.QUADS:
      return { name: "Four of a Kind", description: RANK_PLURAL[r[0]] };
    case CAT.FULL_HOUSE:
      return { name: "Full House", description: `${RANK_PLURAL[r[0]]} full of ${RANK_PLURAL[r[1]]}` };
    case CAT.FLUSH:
      return { name: "Flush", description: `${RANK_WORD[r[0]]} high` };
    case CAT.STRAIGHT:
      return {
        name: "Straight",
        description: r[0] === 5 ? "Ace to Five" : `${RANK_WORD[r[0] - 4]} to ${RANK_WORD[r[0]]}`
      };
    case CAT.TRIPS:
      return { name: "Three of a Kind", description: RANK_PLURAL[r[0]] };
    case CAT.TWO_PAIR:
      return { name: "Two Pair", description: `${RANK_PLURAL[r[0]]} and ${RANK_PLURAL[r[1]]}` };
    case CAT.PAIR:
      return { name: "One Pair", description: `Pair of ${RANK_PLURAL[r[0]]}` };
    default:
      return { name: "High Card", description: `${RANK_WORD[r[0]]} high` };
  }
}
function* combinations5(cards) {
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) yield [cards[a], cards[b], cards[c], cards[d], cards[e]];
}
function orderBest(best, score) {
  const cat = scoreCategory(score);
  const counts = /* @__PURE__ */ new Map();
  for (const c of best) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
  const wheel = (cat === CAT.STRAIGHT || cat === CAT.STRAIGHT_FLUSH) && scoreRanks(score)[0] === 5;
  const val = (c) => wheel && c.rank === 14 ? 1 : c.rank;
  return best.slice().sort((x, y) => {
    const cx = counts.get(x.rank);
    const cy = counts.get(y.rank);
    if (cx !== cy) return cy - cx;
    return val(y) - val(x);
  });
}
function evaluateHand(cards) {
  if (cards.length < 5) {
    const score = evaluatePartial(cards);
    const { name: name2, description: description2 } = describeScore(score);
    return { score, category: scoreCategory(score), name: name2, description: description2, best: cards.slice() };
  }
  let bestScore = -1;
  let best = [];
  if (cards.length === 5) {
    bestScore = evaluate(cards);
    best = cards.slice();
  } else {
    for (const combo of combinations5(cards)) {
      const s = evaluate(combo);
      if (s > bestScore) {
        bestScore = s;
        best = combo;
      }
    }
  }
  const { name, description } = describeScore(bestScore);
  return { score: bestScore, category: scoreCategory(bestScore), name, description, best: orderBest(best, bestScore) };
}
function evaluatePartial(cards) {
  const counts = /* @__PURE__ */ new Map();
  for (const c of cards) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const ranks = groups.map((g) => g[0]);
  const top = groups[0]?.[1] ?? 0;
  if (top === 4) return pack(CAT.QUADS, ranks);
  if (top === 3) return pack(CAT.TRIPS, ranks);
  if (top === 2 && groups[1]?.[1] === 2) return pack(CAT.TWO_PAIR, ranks);
  if (top === 2) return pack(CAT.PAIR, ranks);
  return pack(CAT.HIGH, ranks);
}

// src/game/pots/pots.ts
function computePots(players2) {
  const live2 = players2.filter((p) => !p.folded && p.committed > 0);
  const maxAll = Math.max(0, ...players2.map((p) => p.committed));
  if (maxAll === 0) return [];
  const levels = [...new Set(live2.map((p) => p.committed))].sort((a, b) => a - b);
  if (levels.length === 0 || levels[levels.length - 1] < maxAll) levels.push(maxAll);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const p of players2) amount += Math.max(0, Math.min(p.committed, level) - Math.min(p.committed, prev));
    const eligible = live2.filter((p) => p.committed >= level).map((p) => p.seat).sort((a, b) => a - b);
    prev = level;
    if (amount === 0) continue;
    const last = pots[pots.length - 1];
    if (eligible.length === 0) {
      if (last) last.amount += amount;
      else pots.push({ amount, eligible: live2.map((p) => p.seat) });
      continue;
    }
    if (last && sameSet(last.eligible, eligible)) last.amount += amount;
    else pots.push({ amount, eligible });
  }
  return pots;
}
function sameSet(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function splitPot(amount, order) {
  const n = order.length;
  if (n === 0) return [];
  const share = Math.floor(amount / n);
  let remainder = amount - share * n;
  return order.map((seat) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { seat, amount: share + extra };
  });
}

// src/game/engine/positions.ts
function nextSeat(state, from, pred) {
  const n = state.seats.length;
  for (let i = 1; i <= n; i++) {
    const s = ((from + i) % n + n) % n;
    const p = state.seats[s];
    if (p && pred(p)) return s;
  }
  return null;
}
function orderFrom(state, from, seats) {
  const n = state.seats.length;
  return seats.slice().sort((a, b) => (a - from - 1 + n) % n - (b - from - 1 + n) % n);
}
var inHand = (p) => p.status === "active" || p.status === "allin" || p.status === "folded";
var live = (p) => p.status === "active" || p.status === "allin";
var canAct = (p) => p.status === "active";
function players(state) {
  return state.seats.filter((p) => p !== null);
}

// src/game/betting/legal.ts
function totalPot(state) {
  return state.pots.reduce((s, p) => s + p.amount, 0) + players(state).reduce((s, p) => s + p.bet, 0);
}
function getLegalActions(state, seat) {
  if (state.stage !== "betting" || state.toAct !== seat) return null;
  const p = state.seats[seat];
  if (!p || p.status !== "active") return null;
  const toCall = Math.max(0, state.currentBet - p.bet);
  const opponentsCanAct = players(state).some((o) => o.seat !== seat && canAct(o));
  const raiseRights = !p.hasActed || p.actedAtRaise < state.fullRaiseCount;
  const maxTo = p.bet + p.stack;
  const canCheck = toCall === 0;
  const canCall = toCall > 0;
  const callAmount = Math.min(toCall, p.stack);
  const canBet = state.currentBet === 0 && p.stack > 0 && opponentsCanAct;
  const canRaise = state.currentBet > 0 && p.stack > toCall && raiseRights && opponentsCanAct;
  let minTo = 0;
  if (canBet) minTo = Math.min(state.config.bigBlind, maxTo);
  else if (canRaise) minTo = Math.min(state.currentBet + state.minRaise, maxTo);
  return {
    seat,
    toCall,
    canFold: toCall > 0,
    canCheck,
    canCall,
    callAmount,
    callIsAllIn: canCall && callAmount >= p.stack,
    canBet,
    canRaise,
    minTo,
    maxTo: canBet || canRaise ? maxTo : 0,
    currentBet: p.bet,
    stack: p.stack,
    pot: totalPot(state)
  };
}
function normaliseAction(legal, action) {
  switch (action.type) {
    case "fold":
      return legal.canFold ? { ok: true, action: { type: "fold" } } : { ok: false, error: "Nothing to fold to \u2013 check instead" };
    case "check":
      return legal.canCheck ? { ok: true, action: { type: "check" } } : { ok: false, error: "Cannot check facing a bet" };
    case "call":
      return legal.canCall ? { ok: true, action: { type: "call" } } : { ok: false, error: "Nothing to call" };
    case "allin": {
      if (legal.canBet) return { ok: true, action: { type: "bet", to: legal.maxTo } };
      if (legal.canRaise) return { ok: true, action: { type: "raise", to: legal.maxTo } };
      if (legal.canCall) return { ok: true, action: { type: "call" } };
      return { ok: false, error: "All-in not available" };
    }
    case "bet":
    case "raise": {
      const isBet = action.type === "bet";
      if (isBet ? !legal.canBet : !legal.canRaise) return { ok: false, error: `Cannot ${action.type} now` };
      const to = Math.floor(action.amount ?? NaN);
      if (!Number.isFinite(to)) return { ok: false, error: "Missing amount" };
      if (to > legal.maxTo) return { ok: false, error: "Amount exceeds stack" };
      if (to < legal.minTo && to !== legal.maxTo) return { ok: false, error: `Minimum is ${legal.minTo}` };
      return { ok: true, action: { type: action.type, to } };
    }
    default:
      return { ok: false, error: "Unknown action" };
  }
}

// src/game/engine/engine.ts
var EngineError = class extends Error {
};
var clone = (s) => structuredClone(s);
function createTable(config) {
  if (config.maxSeats < 2 || config.maxSeats > 10) throw new EngineError("Tables seat 2\u201310 players");
  if (config.smallBlind <= 0 || config.bigBlind < config.smallBlind) throw new EngineError("Invalid blinds");
  return {
    config: { ...config },
    seats: Array.from({ length: config.maxSeats }, () => null),
    handNumber: 0,
    button: -1,
    sbSeat: -1,
    bbSeat: -1,
    stage: "idle",
    street: "preflop",
    deck: [],
    board: [],
    currentBet: 0,
    minRaise: config.bigBlind,
    fullRaiseCount: 0,
    lastAggressor: null,
    toAct: null,
    pots: [],
    runout: false,
    pendingAwards: [],
    record: null
  };
}
var handInProgress = (s) => s.stage === "betting" || s.stage === "roundComplete" || s.stage === "awarding";
function seatPlayer(state, seat, who, stack) {
  if (seat < 0 || seat >= state.seats.length) throw new EngineError("No such seat");
  if (state.seats[seat]) throw new EngineError("Seat taken");
  if (stack <= 0) throw new EngineError("Stack must be positive");
  const s = clone(state);
  s.seats[seat] = {
    ...who,
    seat,
    stack: Math.floor(stack),
    bet: 0,
    committed: 0,
    hole: [],
    status: "sittingOut",
    hasActed: false,
    actedAtRaise: 0,
    shown: false,
    sitOutNext: false,
    autoMuck: who.isBot
  };
  return s;
}
function removePlayer(state, seat) {
  const p = state.seats[seat];
  if (!p) return state;
  if (handInProgress(state) && p.status !== "sittingOut") throw new EngineError("Cannot leave during a hand");
  const s = clone(state);
  s.seats[seat] = null;
  return s;
}
function setStack(state, seat, stack) {
  const p = state.seats[seat];
  if (!p) throw new EngineError("Empty seat");
  if (handInProgress(state) && p.status !== "sittingOut") throw new EngineError("Cannot change stack during a hand");
  const s = clone(state);
  s.seats[seat].stack = Math.floor(stack);
  return s;
}
function setPlayerFlags(state, seat, flags) {
  if (!state.seats[seat]) return state;
  const s = clone(state);
  Object.assign(s.seats[seat], flags);
  return s;
}
function canStartHand(state) {
  return !handInProgress(state) && players(state).filter((p) => p.stack > 0 && !p.sitOutNext).length >= 2;
}
function startHand(state, rng) {
  if (handInProgress(state)) throw new EngineError("Hand already in progress");
  const s = clone(state);
  const events = [];
  for (const p of players(s)) {
    p.bet = 0;
    p.committed = 0;
    p.hole = [];
    p.hasActed = false;
    p.actedAtRaise = 0;
    p.shown = false;
    p.status = p.stack > 0 && !p.sitOutNext ? "active" : "sittingOut";
  }
  const dealt = players(s).filter((p) => p.status === "active");
  if (dealt.length < 2) throw new EngineError("Need at least two players with chips");
  const isDealt = (p) => p.status === "active";
  s.button = s.button < 0 ? dealt[rng.int(dealt.length)].seat : nextSeat(s, s.button, isDealt);
  const headsUp = dealt.length === 2;
  s.sbSeat = headsUp ? s.button : nextSeat(s, s.button, isDealt);
  s.bbSeat = nextSeat(s, s.sbSeat, isDealt);
  s.handNumber += 1;
  s.stage = "betting";
  s.street = "preflop";
  s.board = [];
  s.pots = [];
  s.runout = false;
  s.pendingAwards = [];
  s.lastAggressor = null;
  s.fullRaiseCount = 0;
  s.minRaise = s.config.bigBlind;
  s.record = {
    handNumber: s.handNumber,
    startedAt: Date.now(),
    smallBlind: s.config.smallBlind,
    bigBlind: s.config.bigBlind,
    button: s.button,
    sbSeat: s.sbSeat,
    bbSeat: s.bbSeat,
    players: dealt.map((p) => ({ seat: p.seat, id: p.id, name: p.name, startStack: p.stack, hole: null, isBot: p.isBot })),
    actions: [],
    board: [],
    awards: [],
    shown: [],
    mucked: [],
    uncalled: [],
    totalPot: 0
  };
  events.push({ type: "handStart", handNumber: s.handNumber, button: s.button, sbSeat: s.sbSeat, bbSeat: s.bbSeat });
  const post = (seat, kind, nominal) => {
    const p = s.seats[seat];
    const amount = Math.min(nominal, p.stack);
    p.stack -= amount;
    p.bet += amount;
    p.committed += amount;
    const allIn = p.stack === 0;
    if (allIn) p.status = "allin";
    events.push({ type: "blind", seat, kind, amount, allIn });
    s.record.actions.push({ street: "preflop", seat, type: kind, amount, to: p.bet, allIn });
  };
  post(s.sbSeat, "sb", s.config.smallBlind);
  post(s.bbSeat, "bb", s.config.bigBlind);
  const bb = s.seats[s.bbSeat];
  const sb = s.seats[s.sbSeat];
  s.currentBet = bb.status === "allin" ? Math.max(bb.bet, sb.bet) : s.config.bigBlind;
  s.deck = shuffle(createDeck(), rng);
  const order = orderFrom(s, s.button, dealt.map((p) => p.seat));
  for (let round = 0; round < 2; round++) for (const seat of order) s.seats[seat].hole.push(s.deck.pop());
  events.push({ type: "dealHole", order });
  s.toAct = findNextToAct(s, s.bbSeat);
  if (s.toAct === null || isRoundComplete(s)) closeBettingRound(s, events);
  return { state: s, events };
}
function needsToAct(s, p) {
  return canAct(p) && (!p.hasActed || p.bet < s.currentBet);
}
function findNextToAct(s, from) {
  return nextSeat(s, from, (p) => needsToAct(s, p));
}
function isRoundComplete(s) {
  const actors = players(s).filter(canAct);
  if (actors.length === 0) return true;
  if (actors.length === 1 && actors[0].bet >= s.currentBet) {
    return true;
  }
  return actors.every((p) => p.hasActed && p.bet === s.currentBet);
}
function applyAction(state, seat, intent) {
  const legal = getLegalActions(state, seat);
  if (!legal) throw new EngineError(state.toAct === seat ? "Cannot act now" : "Not your turn");
  const norm = normaliseAction(legal, intent);
  if (!norm.ok) throw new EngineError(norm.error);
  const s = clone(state);
  const events = [];
  const p = s.seats[seat];
  const a = norm.action;
  let recordType = a.type;
  let added = 0;
  switch (a.type) {
    case "fold":
      p.status = "folded";
      break;
    case "check":
      break;
    case "call":
      added = Math.min(s.currentBet - p.bet, p.stack);
      break;
    case "bet":
    case "raise": {
      added = a.to - p.bet;
      const raiseSize = a.to - s.currentBet;
      if (raiseSize >= s.minRaise) {
        s.minRaise = raiseSize;
        s.fullRaiseCount += 1;
      }
      s.currentBet = a.to;
      s.lastAggressor = seat;
      recordType = a.type;
      break;
    }
  }
  p.stack -= added;
  p.bet += added;
  p.committed += added;
  if (p.stack === 0 && p.status === "active") p.status = "allin";
  p.hasActed = true;
  p.actedAtRaise = s.fullRaiseCount;
  const allIn = p.status === "allin" && added > 0;
  s.record.actions.push({ street: s.street, seat, type: recordType, amount: added, to: p.bet, allIn });
  events.push({ type: "action", seat, action: recordType, amount: added, to: p.bet, allIn });
  const remaining = players(s).filter(live);
  if (remaining.length === 1) {
    closeBettingRound(s, events);
    awardUncontested(s, remaining[0].seat);
    return { state: s, events };
  }
  if (isRoundComplete(s)) closeBettingRound(s, events);
  else s.toAct = findNextToAct(s, seat);
  return { state: s, events };
}
function closeBettingRound(s, events) {
  s.toAct = null;
  const ps = players(s).filter(inHand);
  const sorted = ps.map((p) => p.bet).sort((a, b) => b - a);
  const top = sorted[0] ?? 0;
  const second = sorted[1] ?? 0;
  if (top > second) {
    const p = ps.find((x) => x.bet === top);
    const diff = top - second;
    p.bet -= diff;
    p.committed -= diff;
    p.stack += diff;
    if (p.status === "allin" && p.stack > 0) p.status = "active";
    events.push({ type: "uncalled", seat: p.seat, amount: diff });
    s.record.uncalled.push({ seat: p.seat, amount: diff });
  }
  const bets = ps.filter((p) => p.bet > 0).map((p) => ({ seat: p.seat, amount: p.bet }));
  s.pots = computePots(ps.map((p) => ({ seat: p.seat, committed: p.committed, folded: p.status === "folded" })));
  for (const p of ps) {
    p.bet = 0;
    p.hasActed = false;
    p.actedAtRaise = 0;
  }
  s.currentBet = 0;
  s.minRaise = s.config.bigBlind;
  s.fullRaiseCount = 0;
  if (bets.length) events.push({ type: "collect", bets, pots: s.pots.map((x) => ({ ...x, eligible: [...x.eligible] })) });
  s.stage = "roundComplete";
  const liveP = ps.filter(live);
  if (liveP.length >= 2 && liveP.filter(canAct).length <= 1 && !s.runout) {
    s.runout = true;
    for (const p of orderFrom(s, s.button, liveP.map((x) => x.seat))) {
      const pl = s.seats[p];
      pl.shown = true;
      events.push({ type: "reveal", seat: p, cards: pl.hole.slice(), reason: "allin" });
    }
  }
}
function advance(state) {
  if (state.stage === "awarding") return settle(state);
  if (state.stage !== "roundComplete") throw new EngineError("Betting round still open");
  const s = clone(state);
  const events = [];
  if (s.board.length >= 5) {
    showdown(s, events);
    return { state: s, events };
  }
  s.deck.pop();
  const n = s.board.length === 0 ? 3 : 1;
  const cards = [];
  for (let i = 0; i < n; i++) cards.push(s.deck.pop());
  s.board.push(...cards);
  s.street = s.board.length === 3 ? "flop" : s.board.length === 4 ? "turn" : "river";
  s.record.board = s.board.slice();
  s.lastAggressor = null;
  events.push({ type: "street", street: s.street, cards });
  const actors = players(s).filter(canAct);
  if (!s.runout && actors.length >= 2) {
    s.stage = "betting";
    s.toAct = findNextToAct(s, s.button);
  }
  return { state: s, events };
}
function showdown(s, events) {
  const contenders = players(s).filter(live);
  const hands = /* @__PURE__ */ new Map();
  for (const p of contenders) hands.set(p.seat, evaluateHand([...p.hole, ...s.board]));
  const awards = s.pots.map((pot, potIndex) => {
    const eligible = pot.eligible.filter((seat) => hands.has(seat));
    const best = Math.max(...eligible.map((seat) => hands.get(seat).score));
    const winners = orderFrom(s, s.button, eligible.filter((seat) => hands.get(seat).score === best));
    return {
      potIndex,
      amount: pot.amount,
      winners: splitPot(pot.amount, winners),
      hand: hands.get(winners[0]),
      uncontested: eligible.length === 1
    };
  });
  const winnerSeats = new Set(awards.flatMap((a) => a.winners.map((w) => w.seat)));
  const start = s.lastAggressor !== null && hands.has(s.lastAggressor) ? s.lastAggressor : null;
  let order = orderFrom(s, s.button, contenders.map((p) => p.seat));
  if (start !== null) order = [start, ...order.filter((x) => x !== start)];
  for (const seat of order) {
    const p = s.seats[seat];
    const hand = hands.get(seat);
    const mustShow = winnerSeats.has(seat) || p.shown || !p.autoMuck;
    if (mustShow) {
      p.shown = true;
      events.push({ type: "reveal", seat, cards: p.hole.slice(), hand, reason: "showdown" });
      s.record.shown.push({ seat, hand });
    } else {
      events.push({ type: "muck", seat });
      s.record.mucked.push(seat);
    }
  }
  s.pendingAwards = awards;
  s.stage = "awarding";
}
function awardUncontested(s, seat) {
  const amount = s.pots.reduce((t, p) => t + p.amount, 0);
  s.pendingAwards = [{ potIndex: 0, amount, winners: [{ seat, amount }], uncontested: true }];
  s.stage = "awarding";
}
function settle(state) {
  if (state.stage !== "awarding") throw new EngineError("Nothing to settle");
  const s = clone(state);
  const events = [];
  for (const award of s.pendingAwards) {
    for (const w of award.winners) s.seats[w.seat].stack += w.amount;
    s.record.awards.push(award);
    events.push({ type: "award", award });
  }
  finishHand(s, events);
  return { state: s, events };
}
function finishHand(s, events) {
  s.stage = "complete";
  s.toAct = null;
  s.record.totalPot = s.pots.reduce((t, p) => t + p.amount, 0);
  s.record.board = s.board.slice();
  for (const rp of s.record.players) rp.hole = s.seats[rp.seat]?.hole.slice() ?? null;
  s.pots = [];
  s.pendingAwards = [];
  const busted = players(s).filter((p) => p.stack === 0).map((p) => p.seat);
  for (const seat of busted) s.seats[seat].status = "sittingOut";
  events.push({ type: "handEnd", busted });
}

// src/game/deck/rng.ts
var UINT32 = 4294967296;
function getCrypto() {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
    return globalThis.crypto;
  }
  return null;
}
function createSecureRng() {
  const c = getCrypto();
  const buf = new Uint32Array(64);
  let idx = buf.length;
  const nextU32 = () => {
    if (idx >= buf.length) {
      if (c) c.getRandomValues(buf);
      else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * UINT32);
      idx = 0;
    }
    return buf[idx++];
  };
  return {
    int(max) {
      if (max <= 0) return 0;
      const limit = UINT32 - UINT32 % max;
      let v = nextU32();
      while (v >= limit) v = nextU32();
      return v % max;
    },
    float() {
      return nextU32() / UINT32;
    }
  };
}

// src/game/server/LocalTableServer.ts
var DEFAULT_TIMING = {
  actionTime: 18e3,
  dealPerCard: 110,
  afterAction: 420,
  collect: 650,
  flop: 950,
  turnRiver: 600,
  runoutPause: 1100,
  revealEach: 650,
  nextHand: 3800,
  botThinkMin: 650,
  botThinkMax: 2300
};

// src/game/server/MultiplayerTable.ts
var SEAT_ORDER = {
  2: [0, 1],
  6: [0, 3, 1, 4, 2, 5],
  9: [0, 4, 7, 2, 5, 1, 6, 3, 8]
};
var ROOM_TIMING = { ...DEFAULT_TIMING, actionTime: 2e4, nextHand: 4200 };
var MultiplayerTable = class {
  constructor(code, settings, send, opts = {}) {
    this.code = code;
    this.settings = settings;
    this.send = send;
    this.members = /* @__PURE__ */ new Map();
    this.hostId = null;
    this.started = false;
    this.timer = null;
    this.pending = false;
    this.actDeadline = null;
    this.dealingUntil = 0;
    this.nextHandAt = null;
    this.revealed = [];
    this.chatLog = [];
    this.msgId = 0;
    this.closed = false;
    this.lastActivity = Date.now();
    this.rng = opts.rng ?? createSecureRng();
    this.timing = { ...ROOM_TIMING, ...opts.timing };
    this.state = createTable({ maxSeats: settings.maxSeats, smallBlind: settings.smallBlind, bigBlind: settings.bigBlind });
  }
  // ------------------------------------------------------------------ membership
  get memberCount() {
    return this.members.size;
  }
  get connectedCount() {
    return [...this.members.values()].filter((m) => m.connected).length;
  }
  memberByToken(token) {
    for (const m of this.members.values()) if (m.token === token) return m;
    return null;
  }
  /** Seat a new player (or reattach an existing one when `token` matches a seat). */
  join(p) {
    const existing = this.memberByToken(p.token);
    if (existing) {
      this.reconnect(existing.playerId);
      return { ok: true, member: existing, rejoined: true };
    }
    const name = sanitizeName(p.name);
    if (!name) return { ok: false, error: "invalid", message: "Enter a name to join the table." };
    const seat = (SEAT_ORDER[this.settings.maxSeats] ?? []).find((s) => !this.state.seats[s]);
    if (seat === void 0) return { ok: false, error: "full", message: "This table is full." };
    const member = {
      playerId: p.playerId,
      token: p.token,
      name: this.uniqueName(name),
      avatar: p.avatar,
      seat,
      connected: true,
      disconnectedAt: null,
      leaving: false
    };
    this.state = seatPlayer(this.state, seat, { id: member.playerId, name: member.name, avatar: member.avatar, isBot: false }, this.settings.startingStack);
    this.state = setPlayerFlags(this.state, seat, { autoMuck: true });
    this.members.set(member.playerId, member);
    if (!this.hostId) this.hostId = member.playerId;
    this.touch();
    this.sendChatHistory(member.playerId);
    this.systemChat(`${member.name} joined the table`);
    this.broadcast([]);
    this.maybeScheduleHand();
    return { ok: true, member, rejoined: false };
  }
  reconnect(playerId) {
    const m = this.members.get(playerId);
    if (!m) return;
    const wasAway = !m.connected;
    m.connected = true;
    m.disconnectedAt = null;
    if (!m.leaving) this.state = setPlayerFlags(this.state, m.seat, { sitOutNext: false });
    this.touch();
    this.sendChatHistory(playerId);
    if (wasAway) this.systemChat(`${m.name} is back`);
    this.broadcast([]);
    this.maybeScheduleHand();
  }
  disconnect(playerId) {
    const m = this.members.get(playerId);
    if (!m || !m.connected) return;
    m.connected = false;
    m.disconnectedAt = Date.now();
    this.state = setPlayerFlags(this.state, m.seat, { sitOutNext: true });
    this.systemChat(`${m.name} disconnected`);
    this.broadcast([]);
  }
  leave(playerId) {
    const m = this.members.get(playerId);
    if (!m) return;
    m.leaving = true;
    m.connected = false;
    this.state = setPlayerFlags(this.state, m.seat, { sitOutNext: true });
    const inHand2 = this.isInCurrentHand(m.seat);
    if (!inHand2) {
      this.removeMember(m);
      return;
    }
    if (this.state.stage === "betting" && this.state.toAct === m.seat) this.autoAct(m.seat);
    this.broadcast([]);
  }
  removeMember(m) {
    this.state = removePlayer(this.state, m.seat);
    this.members.delete(m.playerId);
    if (this.hostId === m.playerId) {
      const next = [...this.members.values()].sort((a, b) => Number(b.connected) - Number(a.connected))[0];
      this.hostId = next?.playerId ?? null;
      if (next) this.systemChat(`${next.name} is now the host`);
    }
    this.systemChat(`${m.name} left the table`);
    this.broadcast([]);
  }
  uniqueName(name) {
    const taken = new Set([...this.members.values()].map((m) => m.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; i < 20; i++) {
      const candidate = `${name.slice(0, 13)} ${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return name;
  }
  // ------------------------------------------------------------------ intents
  handleIntent(playerId, intent) {
    const m = this.members.get(playerId);
    if (!m || this.closed) return;
    this.touch();
    try {
      switch (intent.type) {
        case "action": {
          if (intent.handNumber !== this.state.handNumber) return;
          if (this.state.stage !== "betting" || this.state.toAct !== m.seat) {
            this.send(playerId, { type: "error", code: "illegal_action", message: "It is not your turn" });
            return;
          }
          try {
            this.performAction(m.seat, sanitizeAction(intent.action));
          } catch (e) {
            this.send(playerId, { type: "error", code: "illegal_action", message: e.message });
          }
          return;
        }
        case "startGame": {
          if (playerId !== this.hostId) return;
          if (this.started) return;
          if (this.playableCount() < 2) {
            this.send(playerId, { type: "error", code: "illegal_action", message: "You need at least 2 players to start" });
            return;
          }
          this.started = true;
          this.systemChat("The game has started. Good luck!");
          this.clearTimer();
          this.schedule(() => this.beginHand(), 700);
          this.broadcast([]);
          return;
        }
        case "dealNow":
          if (playerId === this.hostId && this.started && !this.handInProgress() && canStartHand(this.state)) {
            this.clearTimer();
            this.beginHand();
          }
          return;
        case "rebuy": {
          const p = this.state.seats[m.seat];
          if (!p || p.stack > 0 || this.isInCurrentHand(m.seat)) return;
          this.state = setStack(this.state, m.seat, this.settings.startingStack);
          this.systemChat(`${m.name} rebought for ${this.settings.startingStack.toLocaleString("en-GB")}`);
          this.broadcast([]);
          this.maybeScheduleHand();
          return;
        }
        case "setAutoMuck":
          this.state = setPlayerFlags(this.state, m.seat, { autoMuck: !!intent.value });
          return;
        case "chat": {
          const text = String(intent.text ?? "").trim().slice(0, 200);
          if (text) this.pushChat({ id: `m${++this.msgId}`, at: Date.now(), seat: m.seat, name: m.name, text });
          return;
        }
        case "reaction": {
          const emoji = String(intent.emoji ?? "").slice(0, 8);
          if (!emoji) return;
          for (const other of this.members.values()) if (other.connected) this.send(other.playerId, { type: "reaction", seat: m.seat, emoji });
          return;
        }
        case "leave":
          this.leave(playerId);
          return;
        default:
          return;
      }
    } catch (err) {
      this.fail(err);
    }
  }
  // ------------------------------------------------------------------ hand flow
  handInProgress() {
    return this.state.stage === "betting" || this.state.stage === "roundComplete" || this.state.stage === "awarding";
  }
  isInCurrentHand(seat) {
    const p = this.state.seats[seat];
    return this.handInProgress() && !!p && p.status !== "sittingOut";
  }
  /** seated players who could be dealt in right now */
  playableCount() {
    return this.state.seats.filter((p) => p && p.stack > 0 && !p.sitOutNext).length;
  }
  maybeScheduleHand() {
    if (!this.started || this.handInProgress() || this.pending || this.closed) return;
    if (!canStartHand(this.state)) return;
    this.nextHandAt = Date.now() + 1500;
    this.schedule(() => this.beginHand(), 1500);
    this.broadcast([]);
  }
  beginHand() {
    this.nextHandAt = null;
    this.revealed = [];
    if (!canStartHand(this.state)) {
      this.broadcast([]);
      return;
    }
    const r = startHand(this.state, this.rng);
    this.state = r.state;
    const deal = r.events.find((e) => e.type === "dealHole");
    const cards = deal && deal.type === "dealHole" ? deal.order.length * 2 : 0;
    const dealTime = 350 + cards * this.timing.dealPerCard;
    this.dealingUntil = Date.now() + dealTime;
    this.broadcast(r.events);
    this.schedule(() => this.step(), dealTime + 250);
  }
  step() {
    const s = this.state;
    switch (s.stage) {
      case "betting":
        this.promptActor();
        return;
      case "roundComplete": {
        const r = advance(s);
        this.state = r.state;
        this.collectReveals(r.events);
        this.broadcast(r.events);
        const street = r.events.find((e) => e.type === "street");
        let wait = 300;
        if (street && street.type === "street") {
          wait = street.street === "flop" ? this.timing.flop : this.timing.turnRiver;
          this.dealingUntil = Date.now() + wait;
          if (this.state.runout) wait += this.timing.runoutPause;
        } else if (this.state.stage === "awarding") {
          wait = 700 + this.revealed.length * this.timing.revealEach;
        }
        this.schedule(() => this.step(), wait);
        return;
      }
      case "awarding": {
        const r = advance(s);
        this.state = r.state;
        this.onHandComplete(r.events);
        return;
      }
      default:
        return;
    }
  }
  promptActor() {
    const seat = this.state.toAct;
    if (seat === null) return;
    const m = this.memberBySeat(seat);
    if (m?.leaving) {
      this.autoAct(seat);
      return;
    }
    this.actDeadline = Date.now() + this.timing.actionTime;
    this.broadcast([]);
    this.schedule(() => this.autoAct(seat), this.timing.actionTime);
  }
  /** Clock ran out (or the player left): check if free, otherwise fold. */
  autoAct(seat) {
    const legal = getLegalActions(this.state, seat);
    if (!legal) return;
    this.performAction(seat, legal.canCheck ? { type: "check" } : { type: "fold" });
  }
  performAction(seat, action) {
    const r = applyAction(this.state, seat, action);
    this.clearTimer();
    this.actDeadline = null;
    this.state = r.state;
    this.collectReveals(r.events);
    this.broadcast(r.events);
    const s = this.state;
    if (s.stage === "betting") this.schedule(() => this.step(), this.timing.afterAction);
    else if (s.stage === "roundComplete") {
      const extra = s.runout ? this.timing.runoutPause : 0;
      this.schedule(() => this.step(), this.timing.afterAction + this.timing.collect + extra);
    } else if (s.stage === "awarding") {
      this.schedule(() => this.step(), this.timing.afterAction + this.timing.collect);
    }
  }
  collectReveals(events) {
    for (const e of events) {
      if (e.type !== "reveal") continue;
      const existing = this.revealed.find((r) => r.seat === e.seat);
      if (existing) existing.hand = e.hand ?? existing.hand;
      else this.revealed.push({ seat: e.seat, hand: e.hand });
    }
  }
  onHandComplete(events) {
    const record = this.state.record;
    const rare = record.awards.some((a) => a.hand && scoreCategory(a.hand.score) >= 7);
    this.nextHandAt = Date.now() + this.timing.nextHand + (rare ? 1800 : 0);
    this.broadcast(events);
    for (const m of this.members.values()) {
      if (m.connected) this.send(m.playerId, { type: "handRecord", record: this.sanitiseRecord(record, m.seat) });
    }
    for (const m of [...this.members.values()]) if (m.leaving) this.removeMember(m);
    if (!canStartHand(this.state)) {
      this.nextHandAt = null;
      this.broadcast([]);
      return;
    }
    this.schedule(() => this.beginHand(), this.nextHandAt - Date.now());
  }
  // ------------------------------------------------------------------ timers
  schedule(fn, ms) {
    this.clearTimer();
    this.pending = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending = false;
      if (this.closed) return;
      try {
        fn();
      } catch (err) {
        this.fail(err);
      }
    }, Math.max(0, ms));
  }
  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = false;
  }
  fail(err) {
    console.error(`[room ${this.code}]`, err);
    this.clearTimer();
    for (const m of this.members.values()) {
      if (m.connected) this.send(m.playerId, { type: "error", code: "server_error", message: err?.message ?? "Unknown error" });
    }
  }
  close() {
    this.closed = true;
    this.clearTimer();
  }
  touch() {
    this.lastActivity = Date.now();
  }
  // ------------------------------------------------------------------ chat
  pushChat(message) {
    this.chatLog = [...this.chatLog, message].slice(-50);
    for (const m of this.members.values()) if (m.connected) this.send(m.playerId, { type: "chat", message });
  }
  systemChat(text) {
    this.pushChat({ id: `m${++this.msgId}`, at: Date.now(), seat: null, name: "Dealer", text, system: true });
  }
  sendChatHistory(playerId) {
    for (const message of this.chatLog) this.send(playerId, { type: "chat", message });
  }
  // ------------------------------------------------------------------ views
  memberBySeat(seat) {
    for (const m of this.members.values()) if (m.seat === seat) return m;
    return null;
  }
  broadcast(events) {
    for (const m of this.members.values()) {
      if (m.connected) this.send(m.playerId, { type: "snapshot", view: this.view(m.seat), events });
    }
  }
  phase() {
    const s = this.state;
    switch (s.stage) {
      case "betting":
        return Date.now() < this.dealingUntil ? "dealing" : "betting";
      case "roundComplete":
        return s.runout ? "allin" : "dealing";
      case "awarding":
        return "showdown";
      case "complete":
        return this.nextHandAt ? "winner" : canStartHand(s) && this.started ? "nextHand" : "waiting";
      default:
        return canStartHand(s) && this.started ? "nextHand" : "waiting";
    }
  }
  /** View for one player: their own hole cards only, others hidden until shown. */
  view(viewer) {
    const s = this.state;
    const hand = s.stage !== "idle";
    const inProgress = this.handInProgress();
    const seats = s.seats.map((p) => {
      if (!p) return null;
      const member = this.memberBySeat(p.seat);
      const dealt = hand && p.status !== "sittingOut";
      const visible = dealt && p.hole.length > 0 && (p.seat === viewer || p.shown);
      const last = s.record ? [...s.record.actions].reverse().find((a) => a.seat === p.seat) : void 0;
      return {
        seat: p.seat,
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        isBot: false,
        stack: p.stack,
        bet: p.bet,
        status: p.status,
        hasCards: dealt && p.status !== "folded" && p.hole.length > 0,
        cards: visible ? p.hole.slice() : null,
        shown: p.shown,
        lastAction: last && s.stage !== "complete" ? { type: last.type, amount: last.amount, to: last.to, allIn: last.allIn, street: last.street } : null,
        waiting: this.started && inProgress && p.status === "sittingOut" && p.stack > 0 && !!member?.connected,
        connected: member?.connected ?? false
      };
    });
    const me = s.seats[viewer];
    const legal = s.stage === "betting" && s.toAct === viewer ? getLegalActions(s, viewer) : null;
    const hostSeat = this.hostId ? this.members.get(this.hostId)?.seat ?? -1 : -1;
    return {
      tableId: `room-${this.code}`,
      tableName: "Private Room",
      smallBlind: s.config.smallBlind,
      bigBlind: s.config.bigBlind,
      maxSeats: s.config.maxSeats,
      heroSeat: viewer,
      handNumber: s.handNumber,
      stage: s.stage,
      phase: this.phase(),
      street: s.street,
      board: s.board.slice(),
      pots: s.pots.map((p) => ({ amount: p.amount, eligible: [...p.eligible] })),
      totalPot: totalPot(s),
      currentBet: s.currentBet,
      button: s.button,
      sbSeat: s.sbSeat,
      bbSeat: s.bbSeat,
      toAct: s.stage === "betting" ? s.toAct : null,
      actDeadline: this.actDeadline,
      actDuration: this.timing.actionTime,
      actRemaining: null,
      seats,
      legal,
      pendingAwards: s.pendingAwards.map((a) => structuredClone(a)),
      revealed: this.revealed.map((r) => ({ ...r })),
      runout: s.runout,
      paused: false,
      nextHandAt: this.nextHandAt,
      heroBusted: this.started && !!me && me.stack === 0 && !this.isInCurrentHand(viewer),
      room: {
        code: this.code,
        hostSeat,
        isHost: hostSeat === viewer,
        started: this.started,
        seated: this.members.size,
        minPlayers: 2,
        startingStack: this.settings.startingStack
      }
    };
  }
  sanitiseRecord(record, viewer) {
    const shown = new Set(record.shown.map((x) => x.seat));
    for (const p of record.players) if (this.state.seats[p.seat]?.shown) shown.add(p.seat);
    const r = structuredClone(record);
    for (const p of r.players) if (p.seat !== viewer && !shown.has(p.seat)) p.hole = null;
    return r;
  }
};
function sanitizeName(raw) {
  return String(raw ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
}
function sanitizeAction(a) {
  const o = a ?? {};
  const types = ["fold", "check", "call", "bet", "raise", "allin"];
  const type = types.find((t) => t === o.type);
  if (!type) throw new Error("Unknown action");
  const amount = typeof o.amount === "number" && Number.isFinite(o.amount) ? Math.floor(o.amount) : void 0;
  return amount === void 0 ? { type } : { type, amount };
}

// server/rooms.ts
var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
var CODE_LENGTH = 6;
var MAX_ROOMS = 1e3;
var EMPTY_ROOM_TTL = 30 * 60 * 1e3;
var IDLE_ROOM_TTL = 12 * 60 * 60 * 1e3;
var BLINDS = [
  [10, 20],
  [25, 50],
  [50, 100],
  [100, 200],
  [250, 500],
  [500, 1e3]
];
function newCode(taken) {
  for (; ; ) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!taken(code)) return code;
  }
}
function normaliseCode(raw) {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LENGTH);
}
function validateSettings(raw) {
  const s = raw ?? {};
  const maxSeats = [2, 6, 9].includes(Number(s.maxSeats)) ? Number(s.maxSeats) : 6;
  const pair = BLINDS.find(([, bb2]) => bb2 === Number(s.bigBlind)) ?? [50, 100];
  const bb = pair[1];
  const stack = Math.round(Number(s.startingStack) || bb * 100);
  if (stack < bb * 20 || stack > bb * 500) return null;
  return { maxSeats, smallBlind: pair[0], bigBlind: bb, startingStack: Math.round(stack / bb) * bb };
}
var AVATARS = /* @__PURE__ */ new Set(["fedora", "glasses", "beard", "bob", "cap", "longhair", "bun", "crew", "hood", "curly", "shades", "mono"]);
var avatarOf = (raw) => AVATARS.has(String(raw)) ? String(raw) : "crew";
var RoomManager = class {
  constructor() {
    this.rooms = /* @__PURE__ */ new Map();
    /** playerId → live connection */
    this.links = /* @__PURE__ */ new Map();
    /** connection id → where it is seated */
    this.seats = /* @__PURE__ */ new Map();
    this.sweeper = setInterval(() => this.sweep(), 6e4);
    this.sweeper.unref?.();
  }
  get roomCount() {
    return this.rooms.size;
  }
  makeTable(code, settings) {
    return new MultiplayerTable(code, settings, (playerId, msg) => this.links.get(playerId)?.send(msg));
  }
  create(conn, payload) {
    if (this.rooms.size >= MAX_ROOMS) return { ok: false, error: "server", message: "The server is busy. Try again in a minute." };
    const name = sanitizeName(payload.name);
    if (!name) return { ok: false, error: "invalid", message: "Enter your name to create a room." };
    const settings = validateSettings(payload.settings);
    if (!settings) return { ok: false, error: "invalid", message: "Those table settings are not allowed." };
    const code = newCode((c) => this.rooms.has(c));
    const table = this.makeTable(code, settings);
    this.rooms.set(code, table);
    const res = this.seat(conn, table, name, avatarOf(payload.avatar));
    if (!res.ok) this.rooms.delete(code);
    return res;
  }
  join(conn, payload) {
    const code = normaliseCode(payload.code);
    if (code.length !== CODE_LENGTH) return { ok: false, error: "invalid", message: "Room codes have 6 letters and numbers." };
    const table = this.rooms.get(code);
    if (!table) return { ok: false, error: "not_found", message: `No room with code ${code}. Check the code and try again.` };
    if (typeof payload.token === "string" && table.memberByToken(payload.token)) return this.rejoin(conn, { code, token: payload.token });
    const name = sanitizeName(payload.name);
    if (!name) return { ok: false, error: "invalid", message: "Enter your name to join." };
    return this.seat(conn, table, name, avatarOf(payload.avatar));
  }
  rejoin(conn, payload) {
    const code = normaliseCode(payload.code);
    const table = this.rooms.get(code);
    if (!table) return { ok: false, error: "not_found", message: "This room has closed." };
    const member = typeof payload.token === "string" ? table.memberByToken(payload.token) : null;
    if (!member) return { ok: false, error: "not_found", message: "Your seat in this room is no longer available." };
    this.detach(conn.id, false);
    for (const [cid, s] of this.seats) if (s.playerId === member.playerId) this.seats.delete(cid);
    this.links.set(member.playerId, conn);
    this.seats.set(conn.id, { code, playerId: member.playerId });
    table.reconnect(member.playerId);
    return { ok: true, code, token: member.token, seat: member.seat, settings: table.settings };
  }
  seat(conn, table, name, avatar) {
    this.detach(conn.id, false);
    const playerId = `p_${randomBytes(8).toString("hex")}`;
    const token = randomBytes(18).toString("base64url");
    this.links.set(playerId, conn);
    const r = table.join({ playerId, token, name, avatar });
    if (!r.ok) {
      this.links.delete(playerId);
      return { ok: false, error: r.error, message: r.message };
    }
    this.seats.set(conn.id, { code: table.code, playerId });
    return { ok: true, code: table.code, token, seat: r.member.seat, settings: table.settings };
  }
  intent(connId, intent) {
    const s = this.seats.get(connId);
    if (!s || !intent || typeof intent !== "object") return;
    const table = this.rooms.get(s.code);
    if (!table) return;
    if (intent.type === "leave") {
      this.detach(connId, true);
      return;
    }
    table.handleIntent(s.playerId, intent);
  }
  /** Connection closed. `leaving` = the player chose to leave, otherwise they may come back. */
  detach(connId, leaving) {
    const s = this.seats.get(connId);
    if (!s) return;
    this.seats.delete(connId);
    const table = this.rooms.get(s.code);
    if (this.links.get(s.playerId)?.id === connId) this.links.delete(s.playerId);
    if (!table) return;
    if (leaving) table.leave(s.playerId);
    else if (!this.links.has(s.playerId)) table.disconnect(s.playerId);
    if (table.memberCount === 0) this.closeRoom(s.code);
  }
  closeRoom(code) {
    this.rooms.get(code)?.close();
    this.rooms.delete(code);
  }
  sweep() {
    const now = Date.now();
    for (const [code, table] of this.rooms) {
      const idle = now - table.lastActivity;
      if (table.connectedCount === 0 && idle > EMPTY_ROOM_TTL || idle > IDLE_ROOM_TTL) this.closeRoom(code);
    }
  }
  close() {
    clearInterval(this.sweeper);
    for (const code of [...this.rooms.keys()]) this.closeRoom(code);
  }
};

// src/net/protocol.ts
var SOCKET_EVENTS = {
  create: "room:create",
  join: "room:join",
  rejoin: "room:rejoin",
  intent: "intent",
  message: "msg"
};

// server/index.ts
var here = fileURLToPath(new URL(".", import.meta.url));
var staticDir = resolve(
  process.env.STATIC_DIR ?? [join(here, "public"), join(here, "..", "dist"), join(here, "..", "dist-single")].find((d) => existsSync(join(d, "index.html"))) ?? join(here, "public")
);
var port = Number(process.env.PORT ?? 3001);
var TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json"
};
function serveStatic(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = normalize(join(staticDir, pathname));
  if (!file.startsWith(staticDir)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(staticDir, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Game files not found. Build the client first (npm run build).");
    return;
  }
  const isHtml = extname(file) === ".html";
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": isHtml ? "no-cache" : "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin"
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}
var http = createServer(serveStatic);
var io = new Server(http, {
  cors: process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(",") } : void 0,
  maxHttpBufferSize: 16 * 1024,
  pingInterval: 2e4,
  pingTimeout: 25e3
});
var rooms = new RoomManager();
var safeAck = (ack) => typeof ack === "function" ? ack : () => void 0;
io.on("connection", (socket) => {
  const conn = { id: socket.id, send: (msg) => socket.emit(SOCKET_EVENTS.message, msg) };
  let windowStart = Date.now();
  let count = 0;
  const allowed = () => {
    const now = Date.now();
    if (now - windowStart > 1e3) {
      windowStart = now;
      count = 0;
    }
    return ++count <= 30;
  };
  socket.on(SOCKET_EVENTS.create, (payload, ack) => {
    if (!allowed()) return;
    safeAck(ack)(rooms.create(conn, payload ?? {}));
  });
  socket.on(SOCKET_EVENTS.join, (payload, ack) => {
    if (!allowed()) return;
    safeAck(ack)(rooms.join(conn, payload ?? {}));
  });
  socket.on(SOCKET_EVENTS.rejoin, (payload, ack) => {
    if (!allowed()) return;
    safeAck(ack)(rooms.rejoin(conn, payload ?? {}));
  });
  socket.on(SOCKET_EVENTS.intent, (intent) => {
    if (!allowed()) return;
    rooms.intent(socket.id, intent);
  });
  socket.on("disconnect", () => rooms.detach(socket.id, false));
});
http.listen(port, () => {
  console.log(`Crown Poker server on :${port} (static files: ${staticDir})`);
});
var shutdown = () => {
  rooms.close();
  io.close();
  http.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
