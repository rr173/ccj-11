import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { timingSafeEqualBuffer } from './crypto.js';
import {
  abandonCorrectionWorkflow,
  confirmStep,
  consumeReviewInvitation,
  createCorrectionWorkflow,
  createReviewInvitation,
  createSession,
  deleteBatchSession,
  deleteReviewSession,
  deleteSession,
  findReceiptRowByNo,
  findUserByLogin,
  getCorrectionPreviewForUser,
  getOrCreateWorkflow,
  getReceiptForOwner,
  getReceiptForWorkflow,
  getReviewerContext,
  getStateForUser,
  getSteps,
  getTimelineForUser,
  getValidReviewSession,
  getValidSession,
  issueToken,
  listInvitationsForOwner,
  listObjectionsForOwner,
  listReceiptsForUser,
  lockObjectionForUser,
  acceptObjection,
  rejectObjection,
  publicWorkflow,
  revokeReceipt,
  revokeReviewInvitation,
  saveDraft,
  rollbackStep,
  snapshotOfReceiptRow,
  submitReviewObjection,
  userQueries,
  createReviewBatch,
  listBatchesForOwner,
  getBatchForOwner,
  startReviewBatch,
  cancelReviewBatch,
  revokeBatchInvitation,
  consumeBatchInvitation,
  getValidBatchSession,
  getBatchReviewerContext,
  submitBatchOpinion,
  decideBatchField,
  reconfigureBatch,
  getBatchOrchestrationHistory,
  sweepBatchTimeouts,
  createAppealRound,
  listAppealRoundsForOwner,
  getAppealRoundForOwner,
  listAppealableFields,
  cancelAppealRound,
  consumeAppealInvitation,
  getValidAppealSession,
  deleteAppealSession,
  getAppealReviewerContext,
  submitAppealOpinion,
  decideAppealField,
  sweepAppealTimeouts,
  listMediatableAppealFields,
  createMediationPackage,
  listMediationPackagesForOwner,
  getMediationPackageForOwner,
  cancelMediationPackage,
  decideMediationField,
  consumeMediationInvitation,
  getValidMediationSession,
  deleteMediationSession,
  getMediationReviewerContext,
  submitMediationOpinion,
  sweepMediationTimeouts,
} from './db.js';
import { validateDraft, validateStepPayload } from './validation.js';
import { stableStringify } from './crypto.js';
import { STEPS } from './workflow.js';
import { peekRateLimit, recordFailure } from './rateLimit.js';
import {
  codeMatches,
  formatReceiptNoInput,
  normalizeCode,
  ownerReceipt,
  publicReceipt,
  renderReceiptDocument,
  RECEIPT_NO_PATTERN,
  CODE_PATTERN,
} from './receipts.js';
import { INVITATION_ERRORS, isValidTtlMinutes } from './reviews.js';
import { parseBatchInput, BATCH_ERRORS, BATCH_SESSION_COOKIE, BATCH_CSRF_COOKIE, ALL_BATCH_FIELDS, BATCH_MAX_INVITATIONS } from './batchReviews.js';
import { parseAppealCreateInput, APPEAL_ERRORS, APPEAL_SESSION_COOKIE, APPEAL_CSRF_COOKIE, APPEAL_REASONS } from './appealReviews.js';
import {
  parseMediationCreateInput,
  MEDIATION_ERRORS,
  MEDIATION_SESSION_COOKIE,
  MEDIATION_CSRF_COOKIE,
  ARBITRATION_SESSION_COOKIE,
  ARBITRATION_CSRF_COOKIE,
} from './mediationReviews.js';

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    // 免登录公开接口：回执核验
    if (url.pathname === '/api/verify' && req.method === 'POST') {
      return publicVerify(req, res, url);
    }
    // 免登录公开页面与脱敏回执文档
    if (url.pathname === '/verify' && req.method === 'GET') {
      return serveStaticFile(req, res, '/verify.html');
    }
    // 回执复核：免登录复核人页面与接口（一次性邀请校验后凭复核会话访问）
    if (url.pathname === '/review' && req.method === 'GET') {
      return serveStaticFile(req, res, '/review.html');
    }
    // 多方复核批次：免登录复核人页面与接口
    if (url.pathname === '/batch-review' && req.method === 'GET') {
      return serveStaticFile(req, res, '/batch-review.html');
    }
    // 复核申诉回合：免登录新复核人页面与接口（只展示本回合授权内容）
    if (url.pathname === '/appeal-review' && req.method === 'GET') {
      return serveStaticFile(req, res, '/appeal-review.html');
    }
    // 争议调解包第一层：免登录调解人页面与接口（只展示本层授权内容）
    if (url.pathname === '/mediation-review' && req.method === 'GET') {
      return serveStaticFile(req, res, '/mediation-review.html');
    }
    // 争议调解包第二层：免登录仲裁人页面与接口（第一层升级后才开放）
    if (url.pathname === '/arbitration-review' && req.method === 'GET') {
      return serveStaticFile(req, res, '/arbitration-review.html');
    }
    if (url.pathname === '/api/appeal-review/validate' && req.method === 'POST') {
      return appealReviewValidate(req, res);
    }
    if (url.pathname === '/api/appeal-review/logout' && req.method === 'POST') {
      return appealReviewLogout(req, res);
    }
    if (url.pathname === '/api/appeal-review/context' && req.method === 'GET') {
      return appealReviewContext(req, res);
    }
    if (url.pathname === '/api/appeal-review/opinions' && req.method === 'POST') {
      return appealReviewSubmit(req, res);
    }
    if (url.pathname === '/api/mediation-review/validate' && req.method === 'POST') {
      return mediationReviewValidate(req, res, 1);
    }
    if (url.pathname === '/api/mediation-review/logout' && req.method === 'POST') {
      return mediationReviewLogout(req, res, 1);
    }
    if (url.pathname === '/api/mediation-review/context' && req.method === 'GET') {
      return mediationReviewContext(req, res, 1);
    }
    if (url.pathname === '/api/mediation-review/opinions' && req.method === 'POST') {
      return mediationReviewSubmit(req, res, 1);
    }
    if (url.pathname === '/api/arbitration-review/validate' && req.method === 'POST') {
      return mediationReviewValidate(req, res, 2);
    }
    if (url.pathname === '/api/arbitration-review/logout' && req.method === 'POST') {
      return mediationReviewLogout(req, res, 2);
    }
    if (url.pathname === '/api/arbitration-review/context' && req.method === 'GET') {
      return mediationReviewContext(req, res, 2);
    }
    if (url.pathname === '/api/arbitration-review/opinions' && req.method === 'POST') {
      return mediationReviewSubmit(req, res, 2);
    }
    if (url.pathname === '/api/batch-review/validate' && req.method === 'POST') {
      return batchReviewValidate(req, res);
    }
    if (url.pathname === '/api/batch-review/logout' && req.method === 'POST') {
      return batchReviewLogout(req, res);
    }
    if (url.pathname === '/api/batch-review/context' && req.method === 'GET') {
      return batchReviewContext(req, res);
    }
    if (url.pathname === '/api/batch-review/opinions' && req.method === 'POST') {
      return batchReviewSubmit(req, res);
    }
    if (url.pathname === '/api/review/validate' && req.method === 'POST') {
      return reviewValidate(req, res);
    }
    if (url.pathname === '/api/review/logout' && req.method === 'POST') {
      return reviewLogout(req, res);
    }
    if (url.pathname === '/api/review/context' && req.method === 'GET') {
      return reviewContext(req, res);
    }
    if (url.pathname === '/api/review/objections' && req.method === 'POST') {
      return reviewSubmitObjection(req, res);
    }
    const publicDocMatch = /^\/api\/public\/receipts\/([^/]+)\/print$/.exec(url.pathname);
    if (publicDocMatch && req.method === 'GET') {
      return servePublicReceiptDoc(req, res, url, publicDocMatch[1]);
    }

    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return serveStaticFile(req, res, url.pathname === '/' ? '/index.html' : url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: '服务端内部错误' } });
  }
});

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, securityHeaders());
    res.end();
    return;
  }

  if (!['GET', 'POST'].includes(req.method)) {
    return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    return login(req, res);
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    return logout(req, res);
  }

  const session = await requireAuth(req, res);
  if (!session) return;

  if (req.method === 'POST' && !checkCsrf(req, session)) {
    return sendJson(res, 403, { error: { code: 'CSRF_INVALID', message: '请求来源校验失败' } });
  }

  const user = userQueries.findById(session.user_id);
  if (!user) return sendJson(res, 401, { error: { code: 'UNAUTHENTICATED' } });

  if (url.pathname === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, { user: safeUser(user), ...getStateForUser(user.id) });
  }

  if (url.pathname === '/api/tokens' && req.method === 'POST') {
    return claimToken(req, res, user, session);
  }
  if (url.pathname === '/api/drafts' && req.method === 'POST') {
    return putDraft(req, res, user);
  }
  if (url.pathname === '/api/submissions' && req.method === 'POST') {
    return submitStep(req, res, user, session);
  }
  if (url.pathname === '/api/rollback' && req.method === 'POST') {
    return rollback(req, res, user);
  }

  // 回执相关
  if (url.pathname === '/api/receipts' && req.method === 'GET') {
    return sendJson(res, 200, { receipts: listReceiptsForUser(user.id) });
  }
  const receiptDocMatch = /^\/api\/receipts\/([^/]+)\/print$/.exec(url.pathname);
  if (receiptDocMatch && req.method === 'GET') {
    return serveOwnerReceiptDoc(req, res, user, receiptDocMatch[1]);
  }
  const receiptMatch = /^\/api\/receipts\/([^/]+)$/.exec(url.pathname);
  if (receiptMatch && req.method === 'GET') {
    const receipt = getReceiptForOwner(decodeURIComponent(receiptMatch[1]), user.id);
    if (!receipt) return sendJson(res, 404, { error: { code: 'RECEIPT_NOT_FOUND', message: '回执不存在' } });
    return sendJson(res, 200, {
      receipt,
      reviews: {
        invitations: listInvitationsForOwner(user.id, { receiptNo: receipt.receiptNo }),
        objections: listObjectionsForOwner(user.id, { receiptNo: receipt.receiptNo }),
      },
    });
  }
  if (receiptMatch && req.method === 'POST' && url.searchParams.get('action') === 'revoke') {
    return revokeOwnerReceipt(req, res, user, receiptMatch[1]);
  }
  if (url.pathname === '/api/corrections' && req.method === 'POST') {
    if (url.searchParams.get('action') === 'abandon') {
      return abandonCorrection(req, res, user);
    }
    return startCorrection(req, res, user);
  }
  if (url.pathname === '/api/corrections/preview' && req.method === 'GET') {
    const correction = getCorrectionPreviewForUser(user.id);
    if (!correction) {
      return sendJson(res, 404, { error: { code: 'NO_CORRECTION_IN_PROGRESS', message: '当前没有进行中的更正' } });
    }
    return sendJson(res, 200, { correction });
  }

  // 回执复核协作（办理人）
  if (url.pathname === '/api/reviews/invitations' && req.method === 'POST') {
    return createInvitation(req, res, user);
  }
  if (url.pathname === '/api/reviews/invitations' && req.method === 'GET') {
    const receiptNo = url.searchParams.get('receiptNo') || '';
    return sendJson(res, 200, { invitations: listInvitationsForOwner(user.id, { receiptNo }) });
  }
  const inviteRevokeMatch = /^\/api\/reviews\/invitations\/([^/]+)\/revoke$/.exec(url.pathname);
  if (inviteRevokeMatch && req.method === 'POST') {
    return revokeInvitation(req, res, user, inviteRevokeMatch[1]);
  }
  if (url.pathname === '/api/reviews/objections' && req.method === 'GET') {
    const receiptNo = url.searchParams.get('receiptNo') || '';
    return sendJson(res, 200, { objections: listObjectionsForOwner(user.id, { receiptNo }) });
  }
  const objectionLockMatch = /^\/api\/reviews\/objections\/([^/]+)\/lock$/.exec(url.pathname);
  if (objectionLockMatch && req.method === 'POST') {
    return lockObjection(req, res, user, session, objectionLockMatch[1]);
  }
  const objectionAcceptMatch = /^\/api\/reviews\/objections\/([^/]+)\/accept$/.exec(url.pathname);
  if (objectionAcceptMatch && req.method === 'POST') {
    return resolveObjection(req, res, user, 'accept', objectionAcceptMatch[1]);
  }
  const objectionRejectMatch = /^\/api\/reviews\/objections\/([^/]+)\/reject$/.exec(url.pathname);
  if (objectionRejectMatch && req.method === 'POST') {
    return resolveObjection(req, res, user, 'reject', objectionRejectMatch[1]);
  }

  // 多方复核批次（办理人）
  if (url.pathname === '/api/review-batches' && req.method === 'POST') {
    return createBatch(req, res, user);
  }
  if (url.pathname === '/api/review-batches' && req.method === 'GET') {
    const receiptNo = url.searchParams.get('receiptNo') || '';
    return sendJson(res, 200, { batches: listBatchesForOwner(user.id, { receiptNo }) });
  }
  if (/^\/api\/review-batches\/field-options$/.test(url.pathname) && req.method === 'GET') {
    return sendJson(res, 200, { fields: ALL_BATCH_FIELDS, maxInvitations: BATCH_MAX_INVITATIONS });
  }
  const batchGetMatch = /^\/api\/review-batches\/([^/]+)$/.exec(url.pathname);
  if (batchGetMatch && req.method === 'GET') {
    const batchId = decodeURIComponent(batchGetMatch[1]);
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(batchId)) {
      return sendJson(res, 400, { error: { code: 'INVALID_BATCH_ID' } });
    }
    const batch = getBatchForOwner({ userId: user.id, batchId });
    if (!batch) return sendJson(res, 404, { error: { code: 'BATCH_NOT_FOUND', message: '复核批次不存在' } });
    return sendJson(res, 200, { batch });
  }
  const batchStartMatch = /^\/api\/review-batches\/([^/]+)\/start$/.exec(url.pathname);
  if (batchStartMatch && req.method === 'POST') {
    return startBatch(req, res, user, batchStartMatch[1]);
  }
  const batchCancelMatch = /^\/api\/review-batches\/([^/]+)\/cancel$/.exec(url.pathname);
  if (batchCancelMatch && req.method === 'POST') {
    return cancelBatch(req, res, user, batchCancelMatch[1]);
  }
  const batchInviteRevokeMatch = /^\/api\/review-batches\/invitations\/([^/]+)\/revoke$/.exec(url.pathname);
  if (batchInviteRevokeMatch && req.method === 'POST') {
    return revokeBatchInvite(req, res, user, batchInviteRevokeMatch[1]);
  }
  const batchFieldDecideMatch = /^\/api\/review-batches\/([^/]+)\/fields\/([^/]+)\/(accept|reject)$/.exec(url.pathname);
  if (batchFieldDecideMatch && req.method === 'POST') {
    return decideBatchFieldRoute(req, res, user, batchFieldDecideMatch[1], batchFieldDecideMatch[2], batchFieldDecideMatch[3]);
  }
  const batchReconfigureMatch = /^\/api\/review-batches\/([^/]+)\/orchestration$/.exec(url.pathname);
  if (batchReconfigureMatch && req.method === 'POST') {
    return reconfigureBatchRoute(req, res, user, batchReconfigureMatch[1]);
  }
  const batchHistoryMatch = /^\/api\/review-batches\/([^/]+)\/history$/.exec(url.pathname);
  if (batchHistoryMatch && req.method === 'GET') {
    const history = getBatchOrchestrationHistory({ userId: user.id, batchId: decodeURIComponent(batchHistoryMatch[1]) });
    if (!history) return sendJson(res, 404, { error: { code: 'BATCH_NOT_FOUND', message: '复核批次不存在' } });
    return sendJson(res, 200, history);
  }

  // 复核申诉回合（办理人）
  if (url.pathname === '/api/review-appeals' && req.method === 'POST') {
    return createAppeal(req, res, user);
  }
  if (url.pathname === '/api/review-appeals' && req.method === 'GET') {
    const batchId = url.searchParams.get('batchId') || '';
    const receiptNo = url.searchParams.get('receiptNo') || '';
    return sendJson(res, 200, { appeals: listAppealRoundsForOwner(user.id, { batchId, receiptNo }) });
  }
  const appealableMatch = /^\/api\/review-batches\/([^/]+)\/appealable-fields$/.exec(url.pathname);
  if (appealableMatch && req.method === 'GET') {
    const fields = listAppealableFields({ userId: user.id, batchId: decodeURIComponent(appealableMatch[1]) });
    if (!fields) return sendJson(res, 404, { error: { code: 'BATCH_NOT_FOUND', message: '复核批次不存在' } });
    return sendJson(res, 200, { fields, reasons: APPEAL_REASONS });
  }
  const appealGetMatch = /^\/api\/review-appeals\/([^/]+)$/.exec(url.pathname);
  if (appealGetMatch && req.method === 'GET') {
    const round = getAppealRoundForOwner({ userId: user.id, roundId: decodeURIComponent(appealGetMatch[1]) });
    if (!round) return sendJson(res, 404, { error: { code: 'APPEAL_NOT_FOUND', message: '申诉回合不存在' } });
    return sendJson(res, 200, { round });
  }
  const appealCancelMatch = /^\/api\/review-appeals\/([^/]+)\/cancel$/.exec(url.pathname);
  if (appealCancelMatch && req.method === 'POST') {
    return cancelAppeal(req, res, user, appealCancelMatch[1]);
  }
  const appealFieldDecideMatch = /^\/api\/review-appeals\/([^/]+)\/fields\/([^/]+)\/(accept|reject)$/.exec(url.pathname);
  if (appealFieldDecideMatch && req.method === 'POST') {
    return decideAppealFieldRoute(req, res, user, appealFieldDecideMatch[1], appealFieldDecideMatch[2], appealFieldDecideMatch[3]);
  }

  // 争议调解包（办理人）
  const mediatableMatch = /^\/api\/review-appeals\/([^/]+)\/mediatable-fields$/.exec(url.pathname);
  if (mediatableMatch && req.method === 'GET') {
    const result = listMediatableAppealFields({ userId: user.id, roundId: decodeURIComponent(mediatableMatch[1]) });
    if (!result) return sendJson(res, 404, { error: { code: 'APPEAL_NOT_FOUND', message: '申诉回合不存在' } });
    return sendJson(res, 200, { source: result });
  }
  if (url.pathname === '/api/mediation-packages' && req.method === 'POST') {
    return createMediation(req, res, user);
  }
  if (url.pathname === '/api/mediation-packages' && req.method === 'GET') {
    const roundId = url.searchParams.get('roundId') || '';
    const receiptNo = url.searchParams.get('receiptNo') || '';
    return sendJson(res, 200, { packages: listMediationPackagesForOwner(user.id, { roundId, receiptNo }) });
  }
  const mediationGetMatch = /^\/api\/mediation-packages\/([^/]+)$/.exec(url.pathname);
  if (mediationGetMatch && req.method === 'GET') {
    const pkg = getMediationPackageForOwner({ userId: user.id, packageId: decodeURIComponent(mediationGetMatch[1]) });
    if (!pkg) return sendJson(res, 404, { error: { code: 'MEDIATION_NOT_FOUND', message: '调解包不存在' } });
    return sendJson(res, 200, { pkg });
  }
  const mediationCancelMatch = /^\/api\/mediation-packages\/([^/]+)\/cancel$/.exec(url.pathname);
  if (mediationCancelMatch && req.method === 'POST') {
    return cancelMediation(req, res, user, mediationCancelMatch[1]);
  }
  const mediationFieldDecideMatch = /^\/api\/mediation-packages\/([^/]+)\/fields\/([^/]+)\/(accept|reject)$/.exec(url.pathname);
  if (mediationFieldDecideMatch && req.method === 'POST') {
    return decideMediationFieldRoute(req, res, user, mediationFieldDecideMatch[1], mediationFieldDecideMatch[2], mediationFieldDecideMatch[3]);
  }

  return sendJson(res, 404, { error: { code: 'NOT_FOUND' } });
}

async function login(req, res) {
  const body = await readJson(req, res);
  if (!body) return;
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) {
    return sendJson(res, 400, { error: { code: 'INVALID_LOGIN', message: '请输入用户名和密码' } });
  }
  const user = findUserByLogin(username, password);
  if (!user) {
    return sendJson(res, 401, { error: { code: 'BAD_CREDENTIALS', message: '用户名或密码错误' } });
  }
  const session = createSession(user.id);
  setSessionCookies(res, session);
  return sendJson(res, 200, {
    user: safeUser(user),
    csrfToken: session.csrf,
    ...getStateForUser(user.id),
  });
}

async function logout(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.sid) deleteSession(cookies.sid);
  res.setHeader('Set-Cookie', [
    `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    `csrf=; SameSite=Lax; Path=/; Max-Age=0`,
  ]);
  return sendJson(res, 200, { ok: true });
}

async function claimToken(req, res, user, session) {
  const body = await readJson(req, res);
  if (!body) return;
  const step = integer(body.step);
  const pageId = String(body.pageId || '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(pageId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_PAGE_ID' } });
  }
  if (!Number.isInteger(step) || step < 0 || step >= STEPS.length) {
    return sendJson(res, 400, { error: { code: 'INVALID_STEP' } });
  }

  const workflow = getOrCreateWorkflow(user.id);
  if (workflow.completed_at) {
    return sendJson(res, 409, {
      error: { code: 'WORKFLOW_COMPLETED', message: '办理已完成' },
      ...envelopeOf(workflow),
    });
  }
  if (workflow.progress !== step) {
    return sendJson(res, 409, {
      error: { code: 'STEP_NOT_CURRENT', message: '只能为服务端当前步骤领取令牌' },
      ...envelopeOf(workflow),
    });
  }

  const issued = issueToken({
    workflowId: workflow.id,
    userId: user.id,
    sessionId: session.id,
    pageId,
    step,
  });
  return sendJson(res, 200, {
    token: issued.token,
    expiresAt: issued.expiresAt,
    ttlMs: config.tokenTtlMs,
    step,
    pageId,
  });
}

async function putDraft(req, res, user) {
  const body = await readJson(req, res);
  if (!body) return;
  const step = integer(body.step);
  if (!Number.isInteger(step) || step < 0 || step >= STEPS.length) {
    return sendJson(res, 400, { error: { code: 'INVALID_STEP' } });
  }
  const validation = validateDraft(step, body.draft);
  if (validation.error) return sendJson(res, 400, { error: validation.error });

  const workflow = getOrCreateWorkflow(user.id);
  const result = saveDraft(workflow.id, step, validation.draft);
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: '只能保存服务端当前步骤的草稿' },
      ...envelopeOf(workflow),
    });
  }
  const refreshed = getOrCreateWorkflow(user.id);
  return sendJson(res, 200, { ok: true, savedAt: result.savedAt, version: refreshed.version });
}

async function submitStep(req, res, user, session) {
  const body = await readJson(req, res);
  if (!body) return;

  const step = integer(body.step);
  const pageId = String(body.pageId || '');
  const token = String(body.token || '');
  const idempotencyKey = String(body.idempotencyKey || '');
  if (!Number.isInteger(step) || step < 0 || step >= STEPS.length) {
    return sendJson(res, 400, { error: { code: 'INVALID_STEP' } });
  }
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(pageId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_PAGE_ID' } });
  }
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(token)) {
    return sendJson(res, 400, { error: { code: 'INVALID_TOKEN' } });
  }
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
    return sendJson(res, 400, { error: { code: 'INVALID_IDEMPOTENCY_KEY' } });
  }

  const validation = validateStepPayload(step, body.payload);
  if (validation.error) return sendJson(res, 400, { error: validation.error });

  const workflow = getOrCreateWorkflow(user.id);
  const requestHash = requestFingerprint({ step, pageId, payload: validation.payload });
  const result = confirmStep({
    workflowId: workflow.id,
    userId: user.id,
    sessionId: session.id,
    pageId,
    step,
    token,
    idempotencyKey,
    payload: validation.payload,
    requestHash,
  });

  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message },
      replayed: false,
      workflow: result.workflow || null,
    });
  }

  return sendJson(res, 200, {
    replay: Boolean(result.replay),
    ok: true,
    submissionId: result.submissionId,
    confirmation: result.confirmation,
    nextStep: result.nextStep,
    completed: result.nextStep === null,
    workflow: result.workflow,
    receipt: result.receipt,
  });
}

async function rollback(req, res, user) {
  const body = await readJson(req, res);
  if (!body) return;
  const targetStep = integer(body.targetStep);
  const expectedVersion = integer(body.expectedVersion);
  const workflow = getOrCreateWorkflow(user.id);
  const result = rollbackStep({
    workflowId: workflow.id,
    userId: user.id,
    targetStep,
    expectedVersion: Number.isInteger(expectedVersion) ? expectedVersion : undefined,
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '退回修改失败' },
      workflow: result.workflow,
    });
  }
  return sendJson(res, 200, { ok: true, workflow: result.workflow });
}

async function revokeOwnerReceipt(req, res, user, rawReceiptNo) {
  const body = await readJson(req, res);
  if (!body) return;
  const receiptNo = formatReceiptNoInput(decodeURIComponent(rawReceiptNo));
  const reason = String(body.reason || '').trim().slice(0, 200);
  const result = revokeReceipt({ userId: user.id, receiptNo, reason });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '撤销失败' },
      receipt: result.receipt || null,
    });
  }
  return sendJson(res, 200, { ok: true, receipt: result.receipt, records: listReceiptsForUser(user.id) });
}

async function startCorrection(req, res, user) {
  const body = await readJson(req, res);
  if (!body) return;
  const sourceReceiptNo = formatReceiptNoInput(String(body.receiptNo || ''));
  if (!RECEIPT_NO_PATTERN.test(sourceReceiptNo)) {
    return sendJson(res, 400, { error: { code: 'INVALID_RECEIPT_NO', message: '回执编号格式不正确' } });
  }
  const result = createCorrectionWorkflow({ userId: user.id, sourceReceiptNo });
  if (!result.ok) {
    // 并发发起只放行一个：失败响应携带最新办理与时间线，调用方据此重新读取最新状态
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '无法发起更正' },
      workflow: result.workflow || null,
      timeline: getTimelineForUser(user.id),
      correction: getCorrectionPreviewForUser(user.id),
    });
  }
  return sendJson(res, 200, {
    ok: true,
    workflow: envelopeOf(result.workflow).workflow,
    records: listReceiptsForUser(user.id),
    timeline: getTimelineForUser(user.id),
    correction: getCorrectionPreviewForUser(user.id),
  });
}

// 放弃更正：只关闭更正产生的新办理记录，原回执内容、状态与核验结果保持不变
async function abandonCorrection(req, res, user) {
  const result = abandonCorrectionWorkflow({ userId: user.id });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '无法放弃更正' },
      timeline: getTimelineForUser(user.id),
    });
  }
  return sendJson(res, 200, { ok: true, sourceReceiptNo: result.sourceReceiptNo, ...getStateForUser(user.id) });
}

// ---------------------------------------------------------------------------
// 回执复核协作：办理人侧
// ---------------------------------------------------------------------------

async function createInvitation(req, res, user) {
  const body = await readJson(req, res);
  if (!body) return;
  const receiptNo = formatReceiptNoInput(String(body.receiptNo || ''));
  if (!RECEIPT_NO_PATTERN.test(receiptNo)) {
    return sendJson(res, 400, { error: { code: 'INVALID_RECEIPT_NO', message: '回执编号格式不正确' } });
  }
  const ttlMinutes = integer(body.ttlMinutes);
  const maxMinutes = Math.floor(config.reviewInviteMaxTtlMs / 60000);
  const minMinutes = Math.ceil(config.reviewInviteMinTtlMs / 60000);
  if (!isValidTtlMinutes(ttlMinutes, maxMinutes) || ttlMinutes < minMinutes) {
    return sendJson(res, 400, {
      error: { code: 'INVALID_TTL', message: `邀请有效期需在 ${minMinutes} 分钟到 ${maxMinutes} 分钟之间` },
    });
  }
  const result = createReviewInvitation({
    userId: user.id,
    receiptNo,
    ttlMs: ttlMinutes * 60000,
    note: String(body.note || ''),
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, { error: { code: result.code, message: result.message || '创建复核邀请失败' } });
  }
  // 邀请链接走相对路径：经反向代理/外部域名访问时由浏览器自动补全当前来源
  const path = `/review?t=${encodeURIComponent(result.token)}`;
  return sendJson(res, 200, {
    ok: true,
    invitation: result.invitation,
    token: result.token,
    url: path,
  });
}

async function revokeInvitation(req, res, user, rawId) {
  const invitationId = decodeURIComponent(rawId);
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(invitationId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_INVITATION_ID' } });
  }
  const result = revokeReviewInvitation({ userId: user.id, invitationId });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '撤销失败' },
      invitation: result.invitation || null,
    });
  }
  return sendJson(res, 200, { ok: true, invitation: result.invitation, reviews: getStateForUser(user.id).reviews });
}

async function lockObjection(req, res, user, session, rawId) {
  const body = await readJson(req, res);
  if (!body) return;
  const objectionId = decodeURIComponent(rawId);
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(objectionId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_OBJECTION_ID' } });
  }
  const result = lockObjectionForUser({ userId: user.id, objectionId, loginSessionId: session.id });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '加锁失败' },
      objection: result.objection || null,
    });
  }
  return sendJson(res, 200, { ok: true, objection: result.objection });
}

async function resolveObjection(req, res, user, action, rawId) {
  const body = await readJson(req, res);
  if (!body) return;
  const objectionId = decodeURIComponent(rawId);
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(objectionId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_OBJECTION_ID' } });
  }
  // 办理人侧会话 id 作为咨询锁持有者；不同浏览器/会话并发处理时只有一个成功
  const cookies = parseCookies(req.headers.cookie);
  const result = action === 'accept'
    ? acceptObjection({ userId: user.id, objectionId, loginSessionId: cookies.sid || '' })
    : rejectObjection({ userId: user.id, objectionId, loginSessionId: cookies.sid || '', reason: String(body.reason || '') });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '处理失败' },
      objection: result.objection || null,
      workflow: result.workflow || null,
      alreadyHandled: result.code === 'OBJECTION_ALREADY_HANDLED',
    });
  }
  const state = getStateForUser(user.id);
  return sendJson(res, 200, {
    ok: true,
    objection: result.objection,
    workflow: result.workflow || null,
    createdCorrection: Boolean(result.created),
    records: state.records,
    timeline: state.timeline,
    reviews: state.reviews,
    correction: state.correction,
  });
}

// ---------------------------------------------------------------------------
// 多方复核批次：办理人侧
// ---------------------------------------------------------------------------

async function createBatch(req, res, user) {
  const body = await readJson(req, res);
  if (!body) return;
  const receiptNo = formatReceiptNoInput(String(body.receiptNo || ''));
  if (!RECEIPT_NO_PATTERN.test(receiptNo)) {
    return sendJson(res, 400, { error: { code: 'INVALID_RECEIPT_NO', message: '回执编号格式不正确' } });
  }
  const maxMinutes = Math.floor(config.reviewInviteMaxTtlMs / 60000);
  const minMinutes = Math.max(1, Math.ceil(config.reviewInviteMinTtlMs / 60000));
  const parsed = parseBatchInput(body, { minMinutes, maxMinutes });
  if (parsed.error) {
    return sendJson(res, 400, { error: parsed.error });
  }
  const receiptRow = findReceiptRowByNo(receiptNo);
  if (!receiptRow || receiptRow.user_id !== user.id) {
    return sendJson(res, 404, { error: { code: 'RECEIPT_NOT_FOUND', message: '回执不存在或不属于当前账号' } });
  }
  if (receiptRow.status === 'revoked') {
    return sendJson(res, 409, { error: { code: 'RECEIPT_REVOKED', message: '已撤销的回执不能创建复核批次' } });
  }
  const result = createReviewBatch({
    userId: user.id,
    receipt: receiptRow,
    config: parsed.value,
    ttlMs: (parsed.value.ttlMinutes || 60) * 60000,
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '创建复核批次失败' },
    });
  }
  const batch = getBatchForOwner({ userId: user.id, batchId: result.batchId });
  // 每个邀请的完整令牌只在创建当次返回一次（与核验码同等对待）
  const links = result.invitations.map((invite) => ({
    invitationId: invite.id,
    label: invite.label,
    token: invite.token,
    url: `/batch-review?t=${encodeURIComponent(invite.token)}`,
  }));
  return sendJson(res, 200, {
    ok: true,
    batch,
    links,
    timeline: getTimelineForUser(user.id),
    reviewBatches: listBatchesForOwner(user.id),
  });
}

async function startBatch(req, res, user, rawBatchId) {
  const body = await readJson(req, res);
  if (!body) return;
  const batchId = decodeURIComponent(rawBatchId);
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(batchId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_BATCH_ID' } });
  }
  const result = startReviewBatch({ userId: user.id, batchId });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '进入复核失败' },
      batch: result.batch || null,
      pending: result.pending || null,
    });
  }
  return sendJson(res, 200, {
    ok: true,
    batch: result.batch,
    timeline: getTimelineForUser(user.id),
    reviewBatches: listBatchesForOwner(user.id),
  });
}

async function cancelBatch(req, res, user, rawBatchId) {
  const body = await readJson(req, res);
  if (!body) return;
  const batchId = decodeURIComponent(rawBatchId);
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(batchId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_BATCH_ID' } });
  }
  const result = cancelReviewBatch({ userId: user.id, batchId, reason: String(body.reason || '') });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '取消批次失败' },
      batch: result.batch || null,
    });
  }
  return sendJson(res, 200, {
    ok: true,
    batch: result.batch,
    timeline: getTimelineForUser(user.id),
    reviewBatches: listBatchesForOwner(user.id),
  });
}

async function revokeBatchInvite(req, res, user, rawInvitationId) {
  const body = await readJson(req, res);
  if (!body) return;
  const invitationId = decodeURIComponent(rawInvitationId);
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(invitationId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_INVITATION_ID' } });
  }
  const result = revokeBatchInvitation({ userId: user.id, invitationId });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '撤销邀请失败' },
      invitation: result.invitation || null,
    });
  }
  return sendJson(res, 200, { ok: true, invitation: result.invitation, reviewBatches: listBatchesForOwner(user.id) });
}

async function decideBatchFieldRoute(req, res, user, rawBatchId, rawFieldId, action) {
  const body = await readJson(req, res);
  if (!body) return;
  const batchId = decodeURIComponent(rawBatchId);
  const batchFieldId = decodeURIComponent(rawFieldId);
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(batchId) || !/^[A-Za-z0-9_-]{20,200}$/.test(batchFieldId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_ID' } });
  }
  const result = decideBatchField({
    userId: user.id,
    batchId,
    batchFieldId,
    action,
    reason: String(body.reason || ''),
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '决议失败' },
      field: result.field || null,
      batch: result.batch || null,
      workflow: result.workflow || null,
      alreadyDecided: result.code === 'BATCH_FIELD_ALREADY_DECIDED',
    });
  }
  const state = getStateForUser(user.id);
  return sendJson(res, 200, {
    ok: true,
    field: result.field,
    workflow: result.workflow || null,
    createdCorrection: Boolean(result.created),
    batchCompleted: Boolean(result.batchCompleted),
    stageAdvanced: Boolean(result.stageAdvanced),
    batch: result.batch,
    records: state.records,
    timeline: state.timeline,
    reviewBatches: state.reviewBatches,
    correction: state.correction,
  });
}

// 办理人在“任何阶段开始前”调整编排：必须携带当前配置版本号（乐观锁）
async function reconfigureBatchRoute(req, res, user, rawBatchId) {
  const body = await readJson(req, res);
  if (!body) return;
  const batchId = decodeURIComponent(rawBatchId);
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(batchId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_BATCH_ID' } });
  }
  const expectedVersion = integer(body.expectedVersion);
  if (!Number.isInteger(expectedVersion)) {
    return sendJson(res, 409, { error: { code: 'BATCH_CONFIG_VERSION_CONFLICT', message: '调整编排必须携带当前配置版本号' } });
  }
  const maxMinutes = Math.floor(config.reviewInviteMaxTtlMs / 60000);
  const minMinutes = Math.max(1, Math.ceil(config.reviewInviteMinTtlMs / 60000));
  const parsed = parseBatchInput(body, { minMinutes, maxMinutes });
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });
  const result = reconfigureBatch({
    userId: user.id,
    batchId,
    expectedVersion,
    config: parsed.value,
    ttlMs: (parsed.value.ttlMinutes || 60) * 60000,
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '调整编排失败' },
      batch: result.batch || null,
      currentVersion: result.currentVersion || null,
    });
  }
  const state = getStateForUser(user.id);
  return sendJson(res, 200, {
    ok: true,
    version: result.version,
    batch: result.batch,
    links: result.links,
    timeline: state.timeline,
    reviewBatches: state.reviewBatches,
  });
}

// ---------------------------------------------------------------------------
// 复核申诉回合：办理人侧
// ---------------------------------------------------------------------------

async function createAppeal(req, res, user) {
  const body = await readJson(req, res);
  if (!body) return;
  const batchId = String(body.batchId || '');
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(batchId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_BATCH_ID' } });
  }
  const maxMinutes = Math.floor(config.reviewInviteMaxTtlMs / 60000);
  const minMinutes = Math.max(1, Math.ceil(config.reviewInviteMinTtlMs / 60000));
  const parsed = parseAppealCreateInput(body, { minMinutes, maxMinutes });
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });
  const result = createAppealRound({
    userId: user.id,
    batchId,
    config: parsed.value,
    ttlMs: parsed.value.ttlMinutes * 60000,
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '创建申诉回合失败' },
      round: result.round || null,
    });
  }
  const round = getAppealRoundForOwner({ userId: user.id, roundId: result.roundId });
  const links = result.invitations.map((invite) => ({
    invitationId: invite.id,
    label: invite.label,
    token: invite.token,
    url: `/appeal-review?t=${encodeURIComponent(invite.token)}`,
  }));
  const state = getStateForUser(user.id);
  return sendJson(res, 200, {
    ok: true,
    round,
    links,
    timeline: state.timeline,
    reviewAppeals: state.reviewAppeals,
    reviewBatches: state.reviewBatches,
  });
}

async function cancelAppeal(req, res, user, rawRoundId) {
  const body = await readJson(req, res);
  if (!body) return;
  const roundId = decodeURIComponent(rawRoundId);
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(roundId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_APPEAL_ID' } });
  }
  const result = cancelAppealRound({ userId: user.id, roundId, reason: String(body.reason || '') });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '取消申诉回合失败' },
      round: result.round || null,
    });
  }
  const state = getStateForUser(user.id);
  return sendJson(res, 200, {
    ok: true,
    round: result.round,
    timeline: state.timeline,
    reviewAppeals: state.reviewAppeals,
  });
}

async function decideAppealFieldRoute(req, res, user, rawRoundId, rawFieldId, action) {
  const body = await readJson(req, res);
  if (!body) return;
  const roundId = decodeURIComponent(rawRoundId);
  const appealFieldId = decodeURIComponent(rawFieldId);
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(roundId) || !/^[A-Za-z0-9_-]{20,200}$/.test(appealFieldId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_ID' } });
  }
  const result = decideAppealField({
    userId: user.id,
    roundId,
    appealFieldId,
    action,
    reason: String(body.reason || ''),
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '申诉决议失败' },
      field: result.field || null,
      round: result.round || null,
      workflow: result.workflow || null,
      alreadyDecided: result.code === 'APPEAL_FIELD_ALREADY_DECIDED',
    });
  }
  const state = getStateForUser(user.id);
  return sendJson(res, 200, {
    ok: true,
    field: result.field,
    workflow: result.workflow || null,
    createdCorrection: Boolean(result.created),
    roundCompleted: Boolean(result.roundCompleted),
    round: result.round,
    records: state.records,
    timeline: state.timeline,
    reviewAppeals: state.reviewAppeals,
    correction: state.correction,
  });
}

// ---------------------------------------------------------------------------
// 争议调解包：办理人侧
// ---------------------------------------------------------------------------

async function createMediation(req, res, user) {
  const body = await readJson(req, res);
  if (!body) return;
  const roundId = String(body.roundId || '');
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(roundId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_MEDIATION', message: '申诉回合标识不正确' } });
  }
  const maxMinutes = Math.floor(config.reviewInviteMaxTtlMs / 60000);
  const minMinutes = Math.max(1, Math.ceil(config.reviewInviteMinTtlMs / 60000));
  const parsed = parseMediationCreateInput(body, { minMinutes, maxMinutes });
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });
  const result = createMediationPackage({ userId: user.id, config: parsed.value });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '生成调解包失败' },
      pkg: result.pkg || null,
    });
  }
  const pkg = getMediationPackageForOwner({ userId: user.id, packageId: result.packageId });
  const tierPath = { 1: 'mediation-review', 2: 'arbitration-review' };
  const links = result.invitations.map((invite) => ({
    invitationId: invite.id,
    tier: invite.tier,
    label: invite.label,
    token: invite.token,
    url: `/${tierPath[invite.tier]}?t=${encodeURIComponent(invite.token)}`,
  }));
  const state = getStateForUser(user.id);
  return sendJson(res, 200, {
    ok: true,
    pkg,
    links,
    timeline: state.timeline,
    mediationPackages: state.mediationPackages,
  });
}

async function cancelMediation(req, res, user, rawPackageId) {
  const body = await readJson(req, res);
  if (!body) return;
  const packageId = decodeURIComponent(rawPackageId);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(packageId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_MEDIATION_ID' } });
  }
  const result = cancelMediationPackage({ userId: user.id, packageId, reason: String(body.reason || '') });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '取消调解包失败' },
      pkg: result.pkg || null,
    });
  }
  const state = getStateForUser(user.id);
  return sendJson(res, 200, {
    ok: true,
    pkg: result.pkg,
    timeline: state.timeline,
    mediationPackages: state.mediationPackages,
  });
}

async function decideMediationFieldRoute(req, res, user, rawPackageId, rawFieldId, action) {
  const body = await readJson(req, res);
  if (!body) return;
  const packageId = decodeURIComponent(rawPackageId);
  const mediationFieldId = decodeURIComponent(rawFieldId);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(packageId) || !/^[A-Za-z0-9_-]{8,200}$/.test(mediationFieldId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_ID' } });
  }
  const result = decideMediationField({
    userId: user.id,
    packageId,
    mediationFieldId,
    action,
    reason: String(body.reason || ''),
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '决议失败' },
      field: result.field || null,
      pkg: result.pkg || null,
      workflow: result.workflow || null,
    });
  }
  const state = getStateForUser(user.id);
  return sendJson(res, 200, {
    ok: true,
    field: result.field,
    workflow: result.workflow || null,
    createdCorrection: Boolean(result.created),
    escalated: Boolean(result.escalated),
    packageCompleted: Boolean(result.packageCompleted),
    packageStatus: result.packageStatus,
    pkg: result.pkg,
    records: state.records,
    timeline: state.timeline,
    mediationPackages: state.mediationPackages,
    correction: state.correction,
  });
}

// ---------------------------------------------------------------------------
// 争议调解包：免登录调解人/仲裁人侧（第一层 mid/mcsrf，第二层 arb/accsrf2）
// ---------------------------------------------------------------------------

const mediationTierCookies = {
  1: { session: MEDIATION_SESSION_COOKIE, csrf: MEDIATION_CSRF_COOKIE },
  2: { session: ARBITRATION_SESSION_COOKIE, csrf: ARBITRATION_CSRF_COOKIE },
};

function mediationCookies(req) {
  return parseCookies(req.headers.cookie);
}

function mediationSessionFromReq(req, tier) {
  const cookies = mediationCookies(req);
  const name = mediationTierCookies[tier].session;
  if (!cookies[name]) return null;
  const review = getValidMediationSession(cookies[name]);
  if (review && review.session.tier !== tier) return null;
  return review;
}

function setMediationSessionCookies(res, tier, { sessionToken, csrf, expiresAt }) {
  const secure = config.cookieSecure ? '; Secure' : '';
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const { session, csrf: csrfName } = mediationTierCookies[tier];
  res.setHeader('Set-Cookie', [
    `${session}=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`,
    `${csrfName}=${csrf}; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`,
  ]);
}

function clearMediationSessionCookies(res, tier) {
  const { session, csrf } = mediationTierCookies[tier];
  res.setHeader('Set-Cookie', [
    `${session}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    `${csrf}=; SameSite=Lax; Path=/; Max-Age=0`,
  ]);
}

function checkMediationCsrf(req, review, tier) {
  const header = req.headers['x-csrf-token'];
  const cookies = mediationCookies(req);
  const secret = review.session.csrf_secret;
  const csrfName = mediationTierCookies[tier].csrf;
  return Boolean(header && cookies[csrfName] && header === secret && timingSafeEqualBuffer(header, secret));
}

async function mediationReviewValidate(req, res, tier) {
  const clientIp = req.socket.remoteAddress || 'unknown';
  const limitKey = `${tier === 2 ? 'arbitration' : 'mediation'}-review-validate:${clientIp}`;
  const rate = { windowMs: config.verifyRateWindowMs, max: config.verifyRateMax };
  const preview = peekRateLimit(limitKey, rate);
  if (!preview.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(preview.retryAfterMs / 1000))));
    return sendJson(res, 429, { error: { code: 'TOO_MANY_REQUESTS', message: '校验尝试过于频繁，请稍后再试' } });
  }
  const body = await readJson(req, res);
  if (!body) return;
  const token = String(body.token || '').trim();
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(token)) {
    recordFailure(limitKey, rate);
    return sendJson(res, 400, {
      error: {
        code: tier === 2 ? 'ARBITRATION_NOT_FOUND' : 'MEDIATION_INVITATION_NOT_FOUND',
        message: MEDIATION_ERRORS[tier === 2 ? 'ARBITRATION_NOT_FOUND' : 'MEDIATION_INVITATION_NOT_FOUND'],
      },
    });
  }
  const result = consumeMediationInvitation({ rawToken: token, clientIp, expectedTier: tier });
  if (!result.ok) {
    recordFailure(limitKey, rate);
    return sendJson(res, result.status, {
      error: { code: result.code, message: result.message || MEDIATION_ERRORS[result.code] || '邀请校验失败' },
    });
  }
  setMediationSessionCookies(res, tier, { sessionToken: result.sessionToken, csrf: result.csrf, expiresAt: result.expiresAt });
  return sendJson(res, 200, {
    ok: true,
    packageId: result.packageId,
    tier: result.tier,
    receiptNo: result.receiptNo,
    label: result.label,
    csrfToken: result.csrf,
    expiresAt: result.expiresAt,
  });
}

async function mediationReviewLogout(req, res, tier) {
  const cookies = mediationCookies(req);
  const name = mediationTierCookies[tier].session;
  if (cookies[name]) deleteMediationSession(cookies[name]);
  clearMediationSessionCookies(res, tier);
  return sendJson(res, 200, { ok: true });
}

function requireMediationSession(req, res, tier, { write = false } = {}) {
  const review = mediationSessionFromReq(req, tier);
  if (!review) {
    sendJson(res, 401, {
      error: {
        code: tier === 2 ? 'ARBITRATION_SESSION_REQUIRED' : 'MEDIATION_SESSION_REQUIRED',
        message: MEDIATION_ERRORS[tier === 2 ? 'ARBITRATION_SESSION_REQUIRED' : 'MEDIATION_SESSION_REQUIRED'],
      },
    });
    return null;
  }
  if (write && !checkMediationCsrf(req, review, tier)) {
    sendJson(res, 403, {
      error: {
        code: tier === 2 ? 'ARBITRATION_CSRF_INVALID' : 'MEDIATION_CSRF_INVALID',
        message: MEDIATION_ERRORS[tier === 2 ? 'ARBITRATION_CSRF_INVALID' : 'MEDIATION_CSRF_INVALID'],
      },
    });
    return null;
  }
  return review;
}

async function mediationReviewContext(req, res, tier) {
  const review = requireMediationSession(req, res, tier);
  if (!review) return;
  const context = getMediationReviewerContext(review);
  if (!context) {
    clearMediationSessionCookies(res, tier);
    return sendJson(res, 404, {
      error: { code: 'MEDIATION_NOT_FOUND', message: MEDIATION_ERRORS.MEDIATION_NOT_FOUND },
    });
  }
  return sendJson(res, 200, { ok: true, csrfToken: review.session.csrf_secret, context });
}

async function mediationReviewSubmit(req, res, tier) {
  const review = requireMediationSession(req, res, tier, { write: true });
  if (!review) return;
  const body = await readJson(req, res);
  if (!body) return;
  const key = String(body.key || '');
  const reason = String(body.reason || '');
  const idempotencyKey = String(body.idempotencyKey || '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
    return sendJson(res, 400, { error: { code: 'INVALID_IDEMPOTENCY_KEY', message: '提交编号格式不正确' } });
  }
  if (body.receiptNo !== undefined && formatReceiptNoInput(String(body.receiptNo)) !== review.session.receipt_no) {
    return sendJson(res, 403, {
      error: {
        code: tier === 2 ? 'ARBITRATION_RECEIPT_MISMATCH' : 'MEDIATION_RECEIPT_MISMATCH',
        message: MEDIATION_ERRORS[tier === 2 ? 'ARBITRATION_RECEIPT_MISMATCH' : 'MEDIATION_RECEIPT_MISMATCH'],
      },
    });
  }
  const requestHash = requestFingerprint({ key, reason });
  const result = submitMediationOpinion({ review, key, reason, idempotencyKey, requestHash });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || MEDIATION_ERRORS[result.code] || '提交失败' },
    });
  }
  return sendJson(res, 200, { ok: true, replay: Boolean(result.replay), opinion: result.opinion });
}

function batchCookies(req) {
  return parseCookies(req.headers.cookie);
}function batchSessionFromReq(req) {
  const cookies = batchCookies(req);
  if (!cookies[BATCH_SESSION_COOKIE]) return null;
  return getValidBatchSession(cookies[BATCH_SESSION_COOKIE]);
}

function setBatchSessionCookies(res, { sessionToken, csrf, expiresAt }) {
  const secure = config.cookieSecure ? '; Secure' : '';
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  res.setHeader('Set-Cookie', [
    `${BATCH_SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`,
    `${BATCH_CSRF_COOKIE}=${csrf}; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`,
  ]);
}

function clearBatchSessionCookies(res) {
  res.setHeader('Set-Cookie', [
    `${BATCH_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    `${BATCH_CSRF_COOKIE}=; SameSite=Lax; Path=/; Max-Age=0`,
  ]);
}

function checkBatchCsrf(req, review) {
  const header = req.headers['x-csrf-token'];
  const cookies = batchCookies(req);
  const secret = review.session.csrf_secret;
  return Boolean(header && cookies[BATCH_CSRF_COOKIE] && header === secret && timingSafeEqualBuffer(header, secret));
}

async function batchReviewValidate(req, res) {
  const clientIp = req.socket.remoteAddress || 'unknown';
  const limitKey = `batch-review-validate:${clientIp}`;
  const rate = { windowMs: config.verifyRateWindowMs, max: config.verifyRateMax };
  const preview = peekRateLimit(limitKey, rate);
  if (!preview.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(preview.retryAfterMs / 1000))));
    return sendJson(res, 429, { error: { code: 'TOO_MANY_REQUESTS', message: '校验尝试过于频繁，请稍后再试' } });
  }
  const body = await readJson(req, res);
  if (!body) return;
  const token = String(body.token || '').trim();
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(token)) {
    recordFailure(limitKey, rate);
    return sendJson(res, 400, { error: { code: 'INVALID_INVITATION', message: BATCH_ERRORS.BATCH_INVITATION_NOT_FOUND } });
  }
  const result = consumeBatchInvitation({ rawToken: token, clientIp });
  if (!result.ok) {
    recordFailure(limitKey, rate);
    return sendJson(res, result.status, {
      error: { code: result.code, message: result.message || BATCH_ERRORS[result.code] || '邀请校验失败' },
      stageOrdinal: result.stageOrdinal ?? null,
    });
  }
  setBatchSessionCookies(res, { sessionToken: result.sessionToken, csrf: result.csrf, expiresAt: result.expiresAt });
  return sendJson(res, 200, {
    ok: true,
    batchId: result.batchId,
    receiptNo: result.receiptNo,
    label: result.label,
    csrfToken: result.csrf,
    expiresAt: result.expiresAt,
    stageOrdinal: result.stageOrdinal ?? null,
    autoStarted: result.autoStarted,
  });
}

async function batchReviewLogout(req, res) {
  const cookies = batchCookies(req);
  if (cookies[BATCH_SESSION_COOKIE]) deleteBatchSession(cookies[BATCH_SESSION_COOKIE]);
  clearBatchSessionCookies(res);
  return sendJson(res, 200, { ok: true });
}

function requireBatchSession(req, res, { write = false } = {}) {
  const review = batchSessionFromReq(req);
  if (!review) {
    sendJson(res, 401, { error: { code: 'BATCH_SESSION_REQUIRED', message: BATCH_ERRORS.BATCH_SESSION_REQUIRED } });
    return null;
  }
  if (write && !checkBatchCsrf(req, review)) {
    sendJson(res, 403, { error: { code: 'BATCH_CSRF_INVALID', message: BATCH_ERRORS.BATCH_CSRF_INVALID } });
    return null;
  }
  return review;
}

// 阶段超时后台扫描间隔：到点即落定，重复扫描幂等
const BATCH_TIMEOUT_SWEEP_MS = Number(process.env.BATCH_TIMEOUT_SWEEP_MS || 5000);
let batchSweepTimer = null;
function startBatchTimeoutSweep() {
  if (batchSweepTimer || process.env.NO_BATCH_SWEEP === '1') return;
  // 启动时先恢复一次：服务在限时内重启后，到点的批次阶段/申诉回合/调解包层级仍会被落定
  try { sweepBatchTimeouts(); } catch { /* 记录但不阻塞启动 */ }
  try { sweepAppealTimeouts(); } catch { /* 同上 */ }
  try { sweepMediationTimeouts(); } catch { /* 同上 */ }
  batchSweepTimer = setInterval(() => {
    try { sweepBatchTimeouts(); } catch (error) { console.error('batch timeout sweep failed', error); }
    try { sweepAppealTimeouts(); } catch (error) { console.error('appeal timeout sweep failed', error); }
    try { sweepMediationTimeouts(); } catch (error) { console.error('mediation timeout sweep failed', error); }
  }, BATCH_TIMEOUT_SWEEP_MS);
  batchSweepTimer.unref?.();
}

async function batchReviewContext(req, res) {
  const review = requireBatchSession(req, res);
  if (!review) return;
  const context = getBatchReviewerContext(review);
  if (!context) {
    clearBatchSessionCookies(res);
    return sendJson(res, 404, { error: { code: 'BATCH_NOT_FOUND', message: BATCH_ERRORS.BATCH_NOT_FOUND } });
  }
  return sendJson(res, 200, { ok: true, csrfToken: review.session.csrf_secret, context });
}

async function batchReviewSubmit(req, res) {
  const review = requireBatchSession(req, res, { write: true });
  if (!review) return;
  const body = await readJson(req, res);
  if (!body) return;
  const key = String(body.key || `${body.step ?? ''}.${body.field || ''}`);
  const reason = String(body.reason || '');
  const idempotencyKey = String(body.idempotencyKey || '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
    return sendJson(res, 400, { error: { code: 'INVALID_IDEMPOTENCY_KEY', message: '提交编号格式不正确' } });
  }
  // 只能用于本批次绑定的那一份回执
  if (body.receiptNo !== undefined && formatReceiptNoInput(String(body.receiptNo)) !== review.session.receipt_no) {
    return sendJson(res, 403, { error: { code: 'BATCH_RECEIPT_MISMATCH', message: BATCH_ERRORS.BATCH_RECEIPT_MISMATCH } });
  }
  const requestHash = requestFingerprint({ key, reason });
  const result = submitBatchOpinion({ review, key, reason, idempotencyKey, requestHash });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || BATCH_ERRORS[result.code] || '提交失败' },
    });
  }
  return sendJson(res, 200, { ok: true, replay: Boolean(result.replay), opinion: result.opinion });
}

// ---------------------------------------------------------------------------
// 复核申诉回合：免登录新复核人侧（独立 Cookie aid / CSRF accsrf，只展示本回合授权内容）
// ---------------------------------------------------------------------------

function appealCookies(req) {
  return parseCookies(req.headers.cookie);
}

function appealSessionFromReq(req) {
  const cookies = appealCookies(req);
  if (!cookies[APPEAL_SESSION_COOKIE]) return null;
  return getValidAppealSession(cookies[APPEAL_SESSION_COOKIE]);
}

function setAppealSessionCookies(res, { sessionToken, csrf, expiresAt }) {
  const secure = config.cookieSecure ? '; Secure' : '';
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  res.setHeader('Set-Cookie', [
    `${APPEAL_SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`,
    `${APPEAL_CSRF_COOKIE}=${csrf}; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`,
  ]);
}

function clearAppealSessionCookies(res) {
  res.setHeader('Set-Cookie', [
    `${APPEAL_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    `${APPEAL_CSRF_COOKIE}=; SameSite=Lax; Path=/; Max-Age=0`,
  ]);
}

function checkAppealCsrf(req, review) {
  const header = req.headers['x-csrf-token'];
  const cookies = appealCookies(req);
  const secret = review.session.csrf_secret;
  return Boolean(header && cookies[APPEAL_CSRF_COOKIE] && header === secret && timingSafeEqualBuffer(header, secret));
}

async function appealReviewValidate(req, res) {
  const clientIp = req.socket.remoteAddress || 'unknown';
  const limitKey = `appeal-review-validate:${clientIp}`;
  const rate = { windowMs: config.verifyRateWindowMs, max: config.verifyRateMax };
  const preview = peekRateLimit(limitKey, rate);
  if (!preview.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(preview.retryAfterMs / 1000))));
    return sendJson(res, 429, { error: { code: 'TOO_MANY_REQUESTS', message: '校验尝试过于频繁，请稍后再试' } });
  }
  const body = await readJson(req, res);
  if (!body) return;
  const token = String(body.token || '').trim();
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(token)) {
    recordFailure(limitKey, rate);
    return sendJson(res, 400, { error: { code: 'INVALID_INVITATION', message: APPEAL_ERRORS.APPEAL_INVITATION_NOT_FOUND } });
  }
  const result = consumeAppealInvitation({ rawToken: token, clientIp });
  if (!result.ok) {
    recordFailure(limitKey, rate);
    return sendJson(res, result.status, {
      error: { code: result.code, message: result.message || APPEAL_ERRORS[result.code] || '邀请校验失败' },
    });
  }
  setAppealSessionCookies(res, { sessionToken: result.sessionToken, csrf: result.csrf, expiresAt: result.expiresAt });
  return sendJson(res, 200, {
    ok: true,
    roundId: result.roundId,
    receiptNo: result.receiptNo,
    label: result.label,
    csrfToken: result.csrf,
    expiresAt: result.expiresAt,
    autoStarted: result.autoStarted,
  });
}

async function appealReviewLogout(req, res) {
  const cookies = appealCookies(req);
  if (cookies[APPEAL_SESSION_COOKIE]) deleteAppealSession(cookies[APPEAL_SESSION_COOKIE]);
  clearAppealSessionCookies(res);
  return sendJson(res, 200, { ok: true });
}

function requireAppealSession(req, res, { write = false } = {}) {
  const review = appealSessionFromReq(req);
  if (!review) {
    sendJson(res, 401, { error: { code: 'APPEAL_SESSION_REQUIRED', message: APPEAL_ERRORS.APPEAL_SESSION_REQUIRED } });
    return null;
  }
  if (write && !checkAppealCsrf(req, review)) {
    sendJson(res, 403, { error: { code: 'APPEAL_CSRF_INVALID', message: APPEAL_ERRORS.APPEAL_CSRF_INVALID } });
    return null;
  }
  return review;
}

async function appealReviewContext(req, res) {
  const review = requireAppealSession(req, res);
  if (!review) return;
  const context = getAppealReviewerContext(review);
  if (!context) {
    clearAppealSessionCookies(res);
    return sendJson(res, 404, { error: { code: 'APPEAL_NOT_FOUND', message: APPEAL_ERRORS.APPEAL_NOT_FOUND } });
  }
  return sendJson(res, 200, { ok: true, csrfToken: review.session.csrf_secret, context });
}

async function appealReviewSubmit(req, res) {
  const review = requireAppealSession(req, res, { write: true });
  if (!review) return;
  const body = await readJson(req, res);
  if (!body) return;
  const key = String(body.key || '');
  const reason = String(body.reason || '');
  const idempotencyKey = String(body.idempotencyKey || '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
    return sendJson(res, 400, { error: { code: 'INVALID_IDEMPOTENCY_KEY', message: '提交编号格式不正确' } });
  }
  if (body.receiptNo !== undefined && formatReceiptNoInput(String(body.receiptNo)) !== review.session.receipt_no) {
    return sendJson(res, 403, { error: { code: 'APPEAL_RECEIPT_MISMATCH', message: APPEAL_ERRORS.APPEAL_RECEIPT_MISMATCH } });
  }
  const requestHash = requestFingerprint({ key, reason });
  const result = submitAppealOpinion({ review, key, reason, idempotencyKey, requestHash });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || APPEAL_ERRORS[result.code] || '提交失败' },
    });
  }
  return sendJson(res, 200, { ok: true, replay: Boolean(result.replay), opinion: result.opinion });
}

function reviewCookies(req) {
  return parseCookies(req.headers.cookie);
}

function reviewSessionFromReq(req) {
  const cookies = reviewCookies(req);
  if (!cookies.rid) return null;
  return getValidReviewSession(cookies.rid);
}

function setReviewSessionCookies(res, { sessionToken, csrf }) {
  const secure = config.cookieSecure ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `rid=${sessionToken}; HttpOnly; SameSite=Lax; Path=/;${secure}`,
    `rcsrf=${csrf}; SameSite=Lax; Path=/${secure}`,
  ]);
}

function clearReviewSessionCookies(res) {
  res.setHeader('Set-Cookie', [
    'rid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    'rcsrf=; SameSite=Lax; Path=/; Max-Age=0',
  ]);
}

function checkReviewCsrf(req, review) {
  const header = req.headers['x-csrf-token'];
  const cookies = reviewCookies(req);
  const secret = review.session.csrf_secret;
  return Boolean(header && cookies.rcsrf && header === secret && timingSafeEqualBuffer(header, secret));
}

function reviewRateParams() {
  return { windowMs: config.verifyRateWindowMs, max: config.verifyRateMax };
}

async function reviewValidate(req, res) {
  const clientIp = req.socket.remoteAddress || 'unknown';
  const limitKey = `review-validate:${clientIp}`;
  const rate = reviewRateParams();
  const preview = peekRateLimit(limitKey, rate);
  if (!preview.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(preview.retryAfterMs / 1000))));
    return sendJson(res, 429, { error: { code: 'TOO_MANY_REQUESTS', message: '校验尝试过于频繁，请稍后再试' } });
  }

  const body = await readJson(req, res);
  if (!body) return;
  const token = String(body.token || '').trim();
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(token)) {
    recordFailure(limitKey, rate);
    return sendJson(res, 400, { error: { code: 'INVALID_INVITATION', message: INVITATION_ERRORS.INVITATION_NOT_FOUND } });
  }

  const result = consumeReviewInvitation({ rawToken: token, clientIp });
  if (!result.ok) {
    recordFailure(limitKey, rate);
    return sendJson(res, result.status, {
      error: { code: result.code, message: INVITATION_ERRORS[result.code] || '邀请校验失败' },
    });
  }
  setReviewSessionCookies(res, { sessionToken: result.sessionToken, csrf: result.csrf });
  return sendJson(res, 200, { ok: true, receiptNo: result.receiptNo, csrfToken: result.csrf, expiresAt: result.expiresAt });
}

async function reviewLogout(req, res) {
  const cookies = reviewCookies(req);
  if (cookies.rid) deleteReviewSession(cookies.rid);
  clearReviewSessionCookies(res);
  return sendJson(res, 200, { ok: true });
}

function requireReviewSession(req, res, { write = false } = {}) {
  const review = reviewSessionFromReq(req);
  if (!review) {
    sendJson(res, 401, { error: { code: 'REVIEW_SESSION_REQUIRED', message: INVITATION_ERRORS.REVIEW_SESSION_REQUIRED } });
    return null;
  }
  if (write && !checkReviewCsrf(req, review)) {
    sendJson(res, 403, { error: { code: 'REVIEW_CSRF_INVALID', message: INVITATION_ERRORS.REVIEW_CSRF_INVALID } });
    return null;
  }
  return review;
}

async function reviewContext(req, res) {
  const review = requireReviewSession(req, res);
  if (!review) return;
  const context = getReviewerContext(review);
  if (!context) {
    clearReviewSessionCookies(res);
    return sendJson(res, 404, { error: { code: 'RECEIPT_NOT_FOUND', message: INVITATION_ERRORS.INVITATION_NOT_FOUND } });
  }
  return sendJson(res, 200, { ok: true, csrfToken: review.session.csrf_secret, context });
}

async function reviewSubmitObjection(req, res) {
  const review = requireReviewSession(req, res, { write: true });
  if (!review) return;
  const body = await readJson(req, res);
  if (!body) return;

  const step = integer(body.step);
  const field = String(body.field || '');
  const reason = String(body.reason || '');
  const idempotencyKey = String(body.idempotencyKey || '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
    return sendJson(res, 400, { error: { code: 'INVALID_IDEMPOTENCY_KEY', message: '提交编号格式不正确' } });
  }
  // 只能针对链接绑定的那一份回执：任何携带其他回执编号的尝试都明确失败
  if (body.receiptNo !== undefined && formatReceiptNoInput(String(body.receiptNo)) !== review.session.receipt_no) {
    return sendJson(res, 403, { error: { code: 'REVIEW_RECEIPT_MISMATCH', message: INVITATION_ERRORS.REVIEW_RECEIPT_MISMATCH } });
  }
  const requestHash = requestFingerprint({ step, field, reason });
  const result = submitReviewObjection({
    reviewSession: review,
    step,
    field,
    reason,
    idempotencyKey,
    requestHash,
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || INVITATION_ERRORS[result.code] || '提交失败' },
    });
  }
  return sendJson(res, 200, { ok: true, replay: Boolean(result.replay), objection: result.objection });
}

// 免登录核验：编号 + 核验码两者都正确才返回结果；按来源 IP 对失败尝试限流
async function publicVerify(req, res) {
  const clientIp = req.socket.remoteAddress || 'unknown';
  const limitKey = `verify:${clientIp}`;
  const rate = { windowMs: config.verifyRateWindowMs, max: config.verifyRateMax };
  const preview = peekRateLimit(limitKey, rate);
  if (!preview.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(preview.retryAfterMs / 1000))));
    return sendJson(res, 429, { error: { code: 'TOO_MANY_REQUESTS', message: '核验失败尝试过于频繁，请稍后再试' } });
  }

  const reject = (status, error) => {
    recordFailure(limitKey, rate);
    return sendJson(res, status, { error });
  };

  const body = await readJson(req, res);
  if (!body) return;
  const receiptNo = formatReceiptNoInput(String(body.receiptNo || ''));
  const code = normalizeCode(String(body.code || ''));
  if (!RECEIPT_NO_PATTERN.test(receiptNo) || !CODE_PATTERN.test(code)) {
    return reject(400, { code: 'INVALID_INPUT', message: '请输入格式正确的回执编号和核验码' });
  }

  const row = findReceiptRowByNo(receiptNo);
  if (!row) {
    return reject(404, { code: 'RECEIPT_NOT_FOUND', message: '回执编号不存在，请核对后重新输入' });
  }
  if (!codeMatches(receiptNo, code)) {
    return reject(403, { code: 'VERIFY_CODE_INVALID', message: '核验码错误，请核对后重新输入' });
  }
  if (row.status === 'revoked') {
    // 核验码正确：这是合法持有人的查询，不算失败尝试
    return sendJson(res, 410, {
      error: {
        code: 'RECEIPT_REVOKED',
        message: '该回执已被撤销，不再作为办理完成的有效凭证',
      },
      receipt: { receiptNo, status: 'revoked', revokedAt: row.revoked_at },
    });
  }

  return sendJson(res, 200, {
    ok: true,
    receipt: publicReceipt(row, snapshotOfReceiptRow(row)),
  });
}

function sendReceiptDocument(res, status, html, receiptNo) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(`receipt-${receiptNo}.html`)}`,
    ...securityHeaders(),
  });
  res.end(html);
}

function serveOwnerReceiptDoc(req, res, user, rawReceiptNo) {
  const receiptNo = formatReceiptNoInput(decodeURIComponent(rawReceiptNo));
  const receipt = getReceiptForOwner(receiptNo, user.id);
  if (!receipt) {
    return sendJson(res, 404, { error: { code: 'RECEIPT_NOT_FOUND', message: '回执不存在' } });
  }
  const html = renderReceiptDocument(receipt, { publicView: false });
  return sendReceiptDocument(res, 200, html, receipt.receiptNo);
}

// 公开文档同样要求先核验（只携带编号不能拿到页面）
async function servePublicReceiptDoc(req, res, url, rawReceiptNo) {
  const receiptNo = formatReceiptNoInput(decodeURIComponent(rawReceiptNo));
  const code = normalizeCode(url.searchParams.get('code') || '');
  if (!RECEIPT_NO_PATTERN.test(receiptNo) || !CODE_PATTERN.test(code)) {
    return sendJson(res, 400, { error: { code: 'INVALID_INPUT', message: '链接缺少有效的回执编号或核验码' } });
  }
  const row = findReceiptRowByNo(receiptNo);
  if (!row) {
    return sendJson(res, 404, { error: { code: 'RECEIPT_NOT_FOUND', message: '回执编号不存在' } });
  }
  if (!codeMatches(receiptNo, code)) {
    return sendJson(res, 403, { error: { code: 'VERIFY_CODE_INVALID', message: '核验码错误' } });
  }
  if (row.status === 'revoked') {
    return sendJson(res, 410, { error: { code: 'RECEIPT_REVOKED', message: '该回执已被撤销' } });
  }
  const receipt = ownerReceipt(row, snapshotOfReceiptRow(row));
  const html = renderReceiptDocument(receipt, { publicView: true });
  return sendReceiptDocument(res, 200, html, receipt.receiptNo);
}

function integer(value) {
  if (typeof value === 'boolean' || value === undefined || value === null || value === '') return NaN;
  return Number.isInteger(value) ? value : Number(value);
}

function requestFingerprint(value) {
  return Buffer.from(stableStringify(value)).toString('base64url');
}

function envelopeOf(workflow) {
  const rows = getSteps(workflow.id);
  return { workflow: publicWorkflow(workflow, rows), receipt: getReceiptForWorkflow(workflow.id) };
}

async function requireAuth(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const session = getValidSession(cookies.sid);
  if (!session) {
    sendJson(res, 401, { error: { code: 'UNAUTHENTICATED', message: '请先登录' } });
    return null;
  }
  return session;
}

function checkCsrf(req, session) {
  const header = req.headers['x-csrf-token'];
  const cookies = parseCookies(req.headers.cookie);
  return Boolean(header && cookies.csrf && header === session.csrf_secret && timingSafeEqualBuffer(header, session.csrf_secret));
}

function setSessionCookies(res, session) {
  const secure = config.cookieSecure ? '; Secure' : '';
  const maxAge = Math.floor(config.sessionTtlMs / 1000);
  res.setHeader('Set-Cookie', [
    `sid=${session.id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`,
    `csrf=${session.csrf}; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`,
  ]);
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  };
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2 && pair[0]),
  );
}

async function readJson(req, res) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    sendJson(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
    return null;
  }
  let raw = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      sendJson(res, 413, { error: { code: 'PAYLOAD_TOO_LARGE' } });
      return null;
    }
    raw += chunk;
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { error: { code: 'INVALID_JSON' } });
    return null;
  }
}

function sendJson(res, status, body) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...securityHeaders(),
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function safeUser(user) {
  return { id: user.id, username: user.username, displayName: user.display_name || user.displayName };
}

async function serveStaticFile(req, res, pathname) {
  const filePath = path.normalize(path.join(config.rootDir, 'public', pathname));
  const publicDir = path.join(config.rootDir, 'public') + path.sep;
  if (!filePath.startsWith(publicDir) && filePath !== path.join(config.rootDir, 'public')) {
    return sendJson(res, 403, { error: { code: 'FORBIDDEN' } });
  }
  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
    };
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
      ...securityHeaders(),
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

if (process.env.NO_AUTO_LISTEN !== '1') {
  server.listen(config.port, () => {
    const port = server.address()?.port || config.port;
    console.log(`Server-authoritative wizard listening on http://0.0.0.0:${port}`);
    console.log(`SQLite database: ${config.dbPath}`);
    startBatchTimeoutSweep();
  });
}

export { server, startBatchTimeoutSweep };
