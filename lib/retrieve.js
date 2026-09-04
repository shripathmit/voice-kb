'use strict';

/**
 * Retrieval over a personal knowledge base.
 *
 * The agent answers questions about one person, which changes the problem in
 * two ways a generic FAQ search gets wrong:
 *
 *  1. The subject is in almost every question ("what do YOU do", "where did
 *     HE study", "tell me about SHRIDHAR") and carries no search signal. Those
 *     tokens are stripped before scoring, and a question that is *only* the
 *     subject routes to the intro entry.
 *  2. The highest-traffic questions are short and idiomatic. "What do you do"
 *     is all stopwords — nothing survives to score. Entries therefore carry
 *     `patterns`, matched as phrases before any scoring happens.
 *
 * Dependency free on purpose. When the real knowledge base lands, this is the
 * only file that has to change: keep `answer()`'s signature and return shape.
 */

// Interrogatives are in here on purpose: nearly every entry answers a "what" or
// a "how", so letting them score turns unrelated questions into weak matches.
const STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'for', 'from', 'get', 'give', 'has', 'have',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'know', 'let', 'like',
  'may', 'me', 'my', 'need', 'of', 'on', 'or', 'our', 'out', 'please', 'said',
  'say', 'should', 'so', 'some', 'tell', 'than', 'that', 'the', 'then', 'there',
  'these', 'this', 'those', 'to', 'told', 'us', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'who', 'whom', 'why', 'will', 'with', 'would',
]);

// Weight per field a query token can hit. Keywords are the strongest signal
// because they are curated; the answer body is the weakest because it is long.
const WEIGHTS = { keywords: 3, question: 2, answer: 1 };
const CONFIDENCE_FLOOR = 0.34;
const PATTERN_CONFIDENCE = 0.99;
const INTRO_CONFIDENCE = 0.6;

/** Lowercase, strip punctuation, collapse whitespace. */
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Crude suffix stripping so "study"/"studied"/"studies" collapse together. */
function stem(token) {
  if (token.length <= 4) return token;
  return token
    .replace(/(ies)$/, 'y')
    .replace(/(ing|ed|es|s)$/, '');
}

function tokenise(text, { keepStopwords = false } = {}) {
  return normalise(text)
    .split(' ')
    .filter(Boolean)
    .filter((t) => keepStopwords || !STOPWORDS.has(t))
    .map(stem);
}

function bigrams(tokens) {
  const pairs = [];
  for (let i = 0; i < tokens.length - 1; i += 1) pairs.push(`${tokens[i]} ${tokens[i + 1]}`);
  return pairs;
}

/** Pre-compute the token sets for every entry once at load time. */
function indexEntry(entry) {
  const questionTokens = tokenise(entry.question);
  return {
    entry,
    patterns: (entry.patterns || []).map(normalise).filter(Boolean),
    fields: {
      keywords: new Set(tokenise((entry.keywords || []).join(' '))),
      question: new Set(questionTokens),
      // The long-form detail is indexed at the same low weight as the answer:
      // it carries names and specifics ("Bachchan", "p99") that appear nowhere
      // else, but it is long enough that hits in it should not count for much.
      answer: new Set(tokenise(`${entry.answer} ${entry.detail || ''}`)),
    },
    bigrams: new Set(bigrams(questionTokens)),
  };
}

function scoreEntry(indexed, queryTokens, queryBigrams) {
  const maxPerToken = WEIGHTS.keywords;
  let score = 0;

  for (const token of queryTokens) {
    let best = 0;
    for (const [field, weight] of Object.entries(WEIGHTS)) {
      if (indexed.fields[field].has(token)) best = Math.max(best, weight);
    }
    score += best;
  }

  // Adjacent word pairs matter: "free time" should beat two loose hits.
  for (const pair of queryBigrams) {
    if (indexed.bigrams.has(pair)) score += maxPerToken;
  }

  const ceiling = maxPerToken * Math.max(queryTokens.length, 1);
  return Math.min(score / ceiling, 1);
}

class KnowledgeBase {
  constructor(data) {
    this.data = data;
    this.index = (data.entries || []).map(indexEntry);

    const subject = data.subject || {};
    this.subjectTokens = new Set(
      tokenise([subject.name, subject.shortName, ...(subject.aliases || [])].filter(Boolean).join(' '), {
        keepStopwords: true,
      }),
    );

    this.introEntry = this.index.find((i) => i.entry.intro) || this.index[0] || null;
  }

  /** Longest pattern wins, so "what do you do for a living" beats "what do you do". */
  matchPattern(normalisedQuestion) {
    let best = null;
    for (const indexed of this.index) {
      for (const pattern of indexed.patterns) {
        if (!normalisedQuestion.includes(pattern)) continue;
        if (!best || pattern.length > best.length) best = { indexed, length: pattern.length };
      }
    }
    return best ? best.indexed : null;
  }

  result(indexed, confidence, extra = {}) {
    return {
      answer: indexed.entry.answer,
      detail: indexed.entry.detail || null,
      matched: true,
      confidence: Number(confidence.toFixed(3)),
      source: {
        id: indexed.entry.id,
        question: indexed.entry.question,
        tags: indexed.entry.tags || [],
        placeholder: Boolean(indexed.entry.placeholder),
      },
      alternatives: [],
      ...extra,
    };
  }

  miss(confidence = 0, alternatives = []) {
    return {
      answer: this.data.fallback,
      detail: null,
      matched: false,
      confidence: Number(confidence.toFixed(3)),
      source: null,
      alternatives,
      via: 'fallback',
    };
  }

  /**
   * @param {string} question raw transcript from the client
   * @returns {{answer: string, matched: boolean, confidence: number, source: object|null, alternatives: string[], via: string}}
   */
  answer(question) {
    const normalised = normalise(question);
    if (!normalised) return this.miss();

    // 1. Phrase match — catches the short, all-stopword questions.
    const byPattern = this.matchPattern(normalised);
    if (byPattern) return this.result(byPattern, PATTERN_CONFIDENCE, { via: 'pattern' });

    // 2. Drop the subject; whoever is being asked about is not a search term.
    const allTokens = tokenise(question);
    const contentTokens = allTokens.filter((t) => !this.subjectTokens.has(t));

    // 3. Nothing but the subject left ("tell me about Shridhar") → introduce him.
    if (contentTokens.length === 0) {
      if (allTokens.length > 0 && this.introEntry) {
        return this.result(this.introEntry, INTRO_CONFIDENCE, { via: 'intro' });
      }
      return this.miss();
    }

    const queryBigrams = bigrams(
      tokenise(question, { keepStopwords: true }).filter((t) => !this.subjectTokens.has(t)),
    );

    const ranked = this.index
      .map((indexed) => ({ indexed, confidence: scoreEntry(indexed, contentTokens, queryBigrams) }))
      .sort((a, b) => b.confidence - a.confidence);

    const top = ranked[0];
    if (!top || top.confidence < CONFIDENCE_FLOOR) {
      return this.miss(top ? top.confidence : 0, ranked.slice(0, 3).map((r) => r.indexed.entry.question));
    }

    return this.result(top.indexed, top.confidence, {
      via: 'score',
      alternatives: ranked
        .slice(1, 3)
        .filter((r) => r.confidence > 0)
        .map((r) => r.indexed.entry.question),
    });
  }

  suggestions(limit = 4) {
    return this.index.slice(0, limit).map((i) => i.entry.question);
  }

}

module.exports = { KnowledgeBase, normalise, tokenise };
