const dayjs = require('dayjs');
const config = require('../config');
const { db } = require('../db');
const { safeJsonParse } = require('./taskService');

const DEFAULT_PAID_DAYS = 365;

function getSetting(key, defaultValue = '') {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function nowIso() {
  return dayjs().toISOString();
}

function defaultEntitlement(userId) {
  return {
    id: null,
    studentId: userId,
    tier: 'free',
    trialStartedAt: null,
    trialEndedAt: null,
    paidStartedAt: null,
    paidUntil: null,
    unlockedSubjects: [],
    packageType: 'none'
  };
}

function parseEntitlementRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    studentId: row.student_id,
    tier: row.tier,
    trialStartedAt: row.trial_started_at,
    trialEndedAt: row.trial_ended_at,
    paidStartedAt: row.paid_started_at,
    paidUntil: row.paid_until,
    unlockedSubjects: safeJsonParse(row.unlocked_subjects, []),
    packageType: row.package_type
  };
}

function computeEffectiveTier(entitlement) {
  if (!entitlement) return 'free';
  const now = dayjs();
  if (entitlement.tier === 'trial' && entitlement.trialEndedAt && dayjs(entitlement.trialEndedAt).isBefore(now)) {
    return 'free';
  }
  if (entitlement.tier === 'paid' && entitlement.paidUntil && dayjs(entitlement.paidUntil).isBefore(now)) {
    return 'free';
  }
  return entitlement.tier;
}

function getUserEntitlement(userId) {
  if (config.freeAccessMode) {
    return { ...defaultEntitlement(userId), effectiveTier: 'free' };
  }

  const row = db.prepare('SELECT * FROM user_entitlements WHERE student_id = ?').get(userId);
  if (!row) return defaultEntitlement(userId);
  const entitlement = parseEntitlementRow(row);
  entitlement.effectiveTier = computeEffectiveTier(entitlement);
  return entitlement;
}

function canAccessContent(userId, content) {
  if (config.freeAccessMode) return true;

  const entitlement = getUserEntitlement(userId);
  const tier = entitlement.effectiveTier || computeEffectiveTier(entitlement);
  const visibility = content.visibility || 'free';

  if (visibility === 'free' || visibility === 'preview') return true;
  if (visibility === 'trial_paid') return tier === 'trial' || tier === 'paid';

  if (visibility === 'all_paid') {
    return tier === 'paid' && entitlement.packageType === 'all_subjects';
  }

  if (visibility === 'subject_paid') {
    if (tier !== 'paid') return false;
    if (entitlement.packageType === 'all_subjects') return true;
    const contentSubjects = content.subjectScope ? content.subjectScope.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (!contentSubjects.length && content.subject) {
      contentSubjects.push(content.subject);
    }
    if (!contentSubjects.length) return true;
    return contentSubjects.some((subject) => entitlement.unlockedSubjects.includes(subject));
  }

  return true;
}

function requireEntitlement(options = {}) {
  const { tier, subject } = options;
  return function checkEntitlement(request, response, next) {
    const userId = request.currentUser && request.currentUser.id;
    if (!userId) {
      response.status(401).json({ error: '未登录。' });
      return;
    }

    if (config.freeAccessMode) {
      request.userEntitlement = getUserEntitlement(userId);
      next();
      return;
    }

    const entitlement = getUserEntitlement(userId);
    const effectiveTier = entitlement.effectiveTier || computeEffectiveTier(entitlement);

    if (tier && tier !== effectiveTier) {
      response.status(403).json({ error: '当前权益不足，无法访问该内容。' });
      return;
    }

    if (subject && effectiveTier !== 'paid') {
      response.status(403).json({ error: '当前权益不足，无法访问该内容。' });
      return;
    }

    if (subject && entitlement.packageType !== 'all_subjects' && !entitlement.unlockedSubjects.includes(subject)) {
      response.status(403).json({ error: '未解锁该科目，无法访问该内容。' });
      return;
    }

    request.userEntitlement = entitlement;
    next();
  };
}

function createTrialEntitlement(userId) {
  if (config.freeAccessMode) return;

  const existing = db.prepare('SELECT id FROM user_entitlements WHERE student_id = ?').get(userId);
  if (existing) return;

  const trialDays = Number(getSetting('trial_days', '7'));
  const started = nowIso();
  const ended = dayjs(started).add(trialDays, 'day').toISOString();

  db.prepare(`
    INSERT INTO user_entitlements (
      student_id, tier, trial_started_at, trial_ended_at, package_type, unlocked_subjects, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, 'trial', started, ended, 'none', '[]', started, started);
}

function logEntitlementChange(studentId, previousTier, newTier, reason) {
  db.prepare(`
    INSERT INTO entitlement_change_logs (student_id, previous_tier, new_tier, reason, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(studentId, previousTier, newTier, reason, nowIso());
}

function downgradeExpiredTrials() {
  if (config.freeAccessMode) return [];

  const now = nowIso();
  const expired = db.prepare(`
    SELECT * FROM user_entitlements
    WHERE tier = 'trial' AND trial_ended_at < ?
  `).all(now);

  const updateStmt = db.prepare(`
    UPDATE user_entitlements
    SET tier = 'free', package_type = 'none', unlocked_subjects = '[]', updated_at = ?
    WHERE id = ?
  `);

  const downgraded = [];
  for (const row of expired) {
    const previousTier = row.tier;
    updateStmt.run(now, row.id);
    logEntitlementChange(row.student_id, previousTier, 'free', 'trial_expired');
    downgraded.push(row.student_id);
  }
  return downgraded;
}

function downgradeExpiredPaid() {
  if (config.freeAccessMode) return [];

  const now = nowIso();
  const expired = db.prepare(`
    SELECT * FROM user_entitlements
    WHERE tier = 'paid' AND paid_until < ?
  `).all(now);

  const updateStmt = db.prepare(`
    UPDATE user_entitlements
    SET tier = 'free', package_type = 'none', unlocked_subjects = '[]', updated_at = ?
    WHERE id = ?
  `);

  const downgraded = [];
  for (const row of expired) {
    const previousTier = row.tier;
    updateStmt.run(now, row.id);
    logEntitlementChange(row.student_id, previousTier, 'free', 'paid_expired');
    downgraded.push(row.student_id);
  }
  return downgraded;
}

function grantEntitlementFromOrder(order, product) {
  if (config.freeAccessMode) return;

  if (!product || !product.package_type) return;
  const packageType = product.package_type;
  if (packageType !== 'single_subject' && packageType !== 'all_subjects') return;

  const userId = order.student_id;
  const entitlement = getUserEntitlement(userId);
  const previousTier = entitlement.tier;
  const paidDays = Number(getSetting('paid_days', String(DEFAULT_PAID_DAYS)));
  const started = nowIso();
  const until = dayjs(started).add(paidDays, 'day').toISOString();

  let unlockedSubjects = entitlement.unlockedSubjects || [];
  if (packageType === 'all_subjects') {
    unlockedSubjects = [];
  } else if (packageType === 'single_subject' && product.subject_scope) {
    const subjects = product.subject_scope.split(',').map((s) => s.trim()).filter(Boolean);
    for (const subject of subjects) {
      if (!unlockedSubjects.includes(subject)) unlockedSubjects.push(subject);
    }
  }

  db.prepare(`
    INSERT INTO user_entitlements (
      student_id, tier, paid_started_at, paid_until, package_type, unlocked_subjects, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id) DO UPDATE SET
      tier = excluded.tier,
      paid_started_at = excluded.paid_started_at,
      paid_until = excluded.paid_until,
      package_type = excluded.package_type,
      unlocked_subjects = excluded.unlocked_subjects,
      updated_at = excluded.updated_at
  `).run(
    userId,
    'paid',
    started,
    until,
    packageType,
    JSON.stringify(unlockedSubjects),
    started,
    started
  );

  logEntitlementChange(userId, previousTier, 'paid', `purchase:${order.id}:${product.id}`);
}

function setUserEntitlement(userId, payload) {
  if (config.freeAccessMode) {
    throw new Error('免费模式下无需配置用户权益。');
  }

  const allowedTiers = ['free', 'trial', 'paid'];
  const tier = payload.tier;
  if (!allowedTiers.includes(tier)) {
    throw new Error('无效的权益层级。');
  }

  const entitlement = getUserEntitlement(userId);
  const previousTier = entitlement.tier;
  const now = nowIso();

  const trialStartedAt = payload.trialStartedAt || entitlement.trialStartedAt || now;
  const trialEndedAt = payload.trialEndedAt || entitlement.trialEndedAt || dayjs(now).add(7, 'day').toISOString();
  const paidStartedAt = payload.paidStartedAt || entitlement.paidStartedAt || now;
  const paidUntil = payload.paidUntil || entitlement.paidUntil || dayjs(now).add(DEFAULT_PAID_DAYS, 'day').toISOString();
  const packageType = payload.packageType || entitlement.packageType || 'none';
  const unlockedSubjects = Array.isArray(payload.unlockedSubjects)
    ? payload.unlockedSubjects
    : (payload.unlockedSubjects ? String(payload.unlockedSubjects).split(',').map((s) => s.trim()).filter(Boolean) : entitlement.unlockedSubjects);

  db.prepare(`
    INSERT INTO user_entitlements (
      student_id, tier, trial_started_at, trial_ended_at, paid_started_at, paid_until, package_type, unlocked_subjects, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id) DO UPDATE SET
      tier = excluded.tier,
      trial_started_at = excluded.trial_started_at,
      trial_ended_at = excluded.trial_ended_at,
      paid_started_at = excluded.paid_started_at,
      paid_until = excluded.paid_until,
      package_type = excluded.package_type,
      unlocked_subjects = excluded.unlocked_subjects,
      updated_at = excluded.updated_at
  `).run(
    userId,
    tier,
    trialStartedAt,
    trialEndedAt,
    paidStartedAt,
    paidUntil,
    packageType,
    JSON.stringify(unlockedSubjects),
    now,
    now
  );

  logEntitlementChange(userId, previousTier, tier, 'manual');
}

module.exports = {
  getUserEntitlement,
  canAccessContent,
  requireEntitlement,
  createTrialEntitlement,
  downgradeExpiredTrials,
  downgradeExpiredPaid,
  grantEntitlementFromOrder,
  setUserEntitlement,
  getSetting,
  computeEffectiveTier
};
