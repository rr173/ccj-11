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
  createCaseGroup,
  addCaseGroupMember,
  configureCaseGroup,
  startCaseGroup,
  cancelCaseGroup,
  getCaseGroupForOwner,
  listCaseGroupsForOwner,
  listGroupablePackages,
  sweepCaseGroupTimeouts,
  recoverCaseGroupsOnStartup,
  createAuditArchive,
  getArchiveForOwner,
  getArchiveForAuditor,
  listArchivesForOwner,
  listArchivesForAuditor,
  listArchiveRejectionsForOwner,
  issueExternalCode,
  consumeExternalCode,
  startArchiveExport,
  getArchiveExportForOwner,
  listArchiveExportsForOwner,
  cancelArchiveExport,
  issueDownloadCredential,
  redeemDownloadCredential,
  listCredentialsForOwner,
  sweepArchiveExports,
  recoverArchiveExportsOnStartup,
  createArchiveComparison,
  verifyComparison,
  getComparisonForOwner,
  listComparisonsForOwner,
  listComparisonsForAuditor,
  getComparisonForAuditor,
  createReplaySession,
  getReplayForOwner,
  listReplaysForOwner,
  issueReplaySubmitToken,
  submitReplayOpinion,
  pauseReplaySession,
  resumeReplaySession,
  cancelReplaySession,
  sweepReplaySessions,
  createReceiptObjection,
  acceptReceiptObjection,
  requestObjectionSupplements,
  rejectReceiptObjection,
  confirmObjectionRevocation,
  supplementReceiptObjection,
  getOwnerObjectionByNo,
  getProcessorObjectionByNo,
  getAuditorObjectionByNo,
  listReceiptObjectionsForOwner,
  listAssignedObjections,
  listAllObjectionsForAuditor,
  sweepObjectionNotifications,
  dispatchPendingObjectionNotifications,
  markObjectionNotificationRead,
  requestObjectionExtension,
  decideObjectionExtension,
  listNotificationsForUser,
  unreadNotificationCount,
  listPendingExtensionsForSupervisor,
  listExtensionsForSupervisor,
  getExtensionForSupervisor,
  listAllNotificationsForAuditor,
  listAllExtensionsForAuditor,
  escalationSummaryForObjection,
  publishCalendarVersion,
  getCurrentCalendarVersion,
  listCalendarVersions,
  getCalendarVersionById,
  previewObjectionCalendarMigration,
  confirmObjectionCalendarMigration,
  getMigrationPreview,
  listMigrationPreviews,
  listAllCalendarMigrationsForAuditor,
} from './db.js';
import {
  parseComparisonCreateInput,
  parseReplayCreateInput,
  parseReplayOpinionInput,
  parseReplayControlInput,
  COMPARISON_ERRORS,
} from './archiveComparisons.js';
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
import {
  OBJECTION_NO_PATTERN,
  formatObjectionNoInput,
  parseTextAttachment,
  validateObjectionReason,
  validateRejectReason,
  validateSupplementNote,
} from './receiptObjections.js';
import {
  validateExtensionReason,
  validateExtensionDecision,
} from './objectionEscalations.js';
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
import {
  parseCaseGroupCreateInput,
  parseCaseGroupConfigInput,
  CASE_GROUP_ERRORS,
} from './caseGroups.js';
import {
  parseArchiveCreateInput,
  parseAuditorGrants,
  ARCHIVE_ERRORS,
  ARCHIVE_SOURCE_LABELS,
  isValidArchiveSourceType,
} from './archives.js';

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
    // 审计归档外部核验：免登录、一次性核验码页面
    if (url.pathname === '/archive-verify' && req.method === 'GET') {
      return serveStaticFile(req, res, '/archive-verify.html');
    }
    // 审计员查阅页面（登录后按角色分流到脱敏归档视图）
    if (url.pathname === '/auditor' && req.method === 'GET') {
      return serveStaticFile(req, res, '/auditor.html');
    }
    // 异议处理人工作台（processor 角色登录后处理撤销异议）
    if (url.pathname === '/processor' && req.method === 'GET') {
      return serveStaticFile(req, res, '/processor.html');
    }
    // 异议主管工作台（supervisor 角色：逾期升级记录与延期审批）
    if (url.pathname === '/supervisor' && req.method === 'GET') {
      return serveStaticFile(req, res, '/supervisor.html');
    }
    if (url.pathname === '/api/archives/external-verify' && req.method === 'POST') {
      return archiveExternalVerify(req, res);
    }
    // 一次性下载凭证兑换文件（无需登录：凭证本身即授权，且只能使用一次）
    const archiveDownloadMatch = /^\/api\/archives\/exports\/([^/]+)\/download$/.exec(url.pathname);
    if (archiveDownloadMatch && req.method === 'GET') {
      return archiveCredentialDownload(req, res, url, archiveDownloadMatch[1]);
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

    // 必须 await：直接 return handleApi() 的 rejection 不会被外层 try/catch 捕获，
    // 会变成 unhandledRejection（请求挂起直至超时）
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
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

  // 异议处理人角色：只能访问被分配异议的处理工作台，不能触发任何办理/回执接口
  if (user.role === 'processor') {
    return handleProcessorApi(req, res, user, url);
  }

  // 异议主管角色：只能查看逾期升级/提醒通知留痕并审批一次延期，无业务写权限
  if (user.role === 'supervisor') {
    return handleSupervisorApi(req, res, user, url);
  }

  // 审计员角色：归档脱敏视图 + 撤销异议完整审计记录，不能触发办理/回执等业务接口
  if (user.role === 'auditor') {
    if (url.pathname === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, { user: safeUser(user) });
    }
    return handleAuditorArchiveApi(req, res, user, url);
  }

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

  // 回执撤销与异议处理（办理人发起 / 查看 / 补充材料）
  if (url.pathname === '/api/receipt-objections' && req.method === 'POST') {
    return createObjection(req, res, user);
  }
  if (url.pathname === '/api/receipt-objections' && req.method === 'GET') {
    const receiptNo = url.searchParams.get('receiptNo') || '';
    return sendJson(res, 200, { objections: listReceiptObjectionsForOwner(user.id, { receiptNo }) });
  }
  const receiptObjectionMatch = /^\/api\/receipt-objections\/([^/]+)$/.exec(url.pathname);
  if (receiptObjectionMatch && req.method === 'GET') {
    const objectionNo = formatObjectionNoInput(decodeURIComponent(receiptObjectionMatch[1]));
    if (!OBJECTION_NO_PATTERN.test(objectionNo)) {
      return sendJson(res, 400, { error: { code: 'INVALID_OBJECTION_NO', message: '异议编号格式不正确' } });
    }
    const objection = getOwnerObjectionByNo(objectionNo, user.id);
    if (!objection) return sendJson(res, 404, { error: { code: 'OBJECTION_NOT_FOUND', message: '异议不存在或不属于当前账号' } });
    objection.escalation = escalationSummaryForObjection(objection.id, { viewer: 'handler', userId: user.id });
    return sendJson(res, 200, { objection });
  }
  const objectionSupplementMatch = /^\/api\/receipt-objections\/([^/]+)\/supplement$/.exec(url.pathname);
  if (objectionSupplementMatch && req.method === 'POST') {
    return supplementObjection(req, res, user, objectionSupplementMatch[1]);
  }

  // 异议超期升级与通知留痕（办理人本人的提醒/升级/延期结果通知）
  if (url.pathname === '/api/receipt-objection-notifications' && req.method === 'GET') {
    return sendJson(res, 200, {
      notifications: listNotificationsForUser({
        userId: user.id,
        role: 'handler',
        status: url.searchParams.get('status') || '',
        kind: url.searchParams.get('kind') || '',
      }),
      unreadCount: unreadNotificationCount({ userId: user.id, role: 'handler' }),
    });
  }
  const ownerNotifyReadMatch = /^\/api\/receipt-objection-notifications\/([^/]+)\/read$/.exec(url.pathname);
  if (ownerNotifyReadMatch && req.method === 'POST') {
    const result = markObjectionNotificationRead({
      userId: user.id, role: 'handler', notificationId: decodeURIComponent(ownerNotifyReadMatch[1]),
    });
    if (!result.ok) {
      return sendJson(res, result.status, { error: { code: result.code, message: result.message } });
    }
    return sendJson(res, 200, { ok: true, notification: result.notification, idempotent: Boolean(result.idempotent) });
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

  // 案件组（跨包冲突协调，办理人）
  if (url.pathname === '/api/case-groups' && req.method === 'POST') {
    return createCaseGroupRoute(req, res, user);
  }
  if (url.pathname === '/api/case-groups' && req.method === 'GET') {
    const batchId = url.searchParams.get('batchId') || '';
    const receiptNo = url.searchParams.get('receiptNo') || '';
    return sendJson(res, 200, { caseGroups: listCaseGroupsForOwner(user.id, { batchId, receiptNo }) });
  }
  const caseGroupCandidatesMatch = /^\/api\/case-groups\/([^/]+)\/candidates$/.exec(url.pathname);
  if (caseGroupCandidatesMatch && req.method === 'GET') {
    const result = listGroupablePackages({ userId: user.id, groupId: decodeURIComponent(caseGroupCandidatesMatch[1]) });
    if (!result) return sendJson(res, 404, { error: { code: 'CASE_GROUP_NOT_FOUND', message: CASE_GROUP_ERRORS.CASE_GROUP_NOT_FOUND } });
    return sendJson(res, 200, result);
  }
  const caseGroupMembersMatch = /^\/api\/case-groups\/([^/]+)\/members$/.exec(url.pathname);
  if (caseGroupMembersMatch && req.method === 'POST') {
    return addCaseGroupMemberRoute(req, res, user, caseGroupMembersMatch[1]);
  }
  const caseGroupConfigMatch = /^\/api\/case-groups\/([^/]+)\/config$/.exec(url.pathname);
  if (caseGroupConfigMatch && req.method === 'POST') {
    return configureCaseGroupRoute(req, res, user, caseGroupConfigMatch[1]);
  }
  const caseGroupStartMatch = /^\/api\/case-groups\/([^/]+)\/start$/.exec(url.pathname);
  if (caseGroupStartMatch && req.method === 'POST') {
    return startCaseGroupRoute(req, res, user, caseGroupStartMatch[1]);
  }
  const caseGroupCancelMatch = /^\/api\/case-groups\/([^/]+)\/cancel$/.exec(url.pathname);
  if (caseGroupCancelMatch && req.method === 'POST') {
    return cancelCaseGroupRoute(req, res, user, caseGroupCancelMatch[1]);
  }
  const caseGroupGetMatch = /^\/api\/case-groups\/([^/]+)$/.exec(url.pathname);
  if (caseGroupGetMatch && req.method === 'GET') {
    const group = getCaseGroupForOwner({ userId: user.id, groupId: decodeURIComponent(caseGroupGetMatch[1]) });
    if (!group) return sendJson(res, 404, { error: { code: 'CASE_GROUP_NOT_FOUND', message: CASE_GROUP_ERRORS.CASE_GROUP_NOT_FOUND } });
    return sendJson(res, 200, { caseGroup: group });
  }

  // 可验证审计归档（办理人）
  if (url.pathname === '/api/archives/auditors' && req.method === 'GET') {
    return sendJson(res, 200, { auditors: userQueries.listByRole('auditor').map((item) => ({ username: item.username, displayName: item.display_name })) });
  }
  if (url.pathname === '/api/archives' && req.method === 'POST') {
    return createArchiveRoute(req, res, user);
  }
  if (url.pathname === '/api/archives' && req.method === 'GET') {
    const sourceType = url.searchParams.get('sourceType') || '';
    const sourceId = url.searchParams.get('sourceId') || '';
    if (sourceType && !isValidArchiveSourceType(sourceType)) {
      return sendJson(res, 400, { error: { code: 'ARCHIVE_SOURCE_INVALID', message: ARCHIVE_ERRORS.ARCHIVE_SOURCE_INVALID } });
    }
    return sendJson(res, 200, {
      archives: listArchivesForOwner(user.id, { sourceType, sourceId }),
      rejections: listArchiveRejectionsForOwner(user.id),
      exports: listArchiveExportsForOwner(user.id),
    });
  }
  const archiveGetMatch = /^\/api\/archives\/([^/]+)$/.exec(url.pathname);
  if (archiveGetMatch && req.method === 'GET') {
    const archive = getArchiveForOwner({ userId: user.id, archiveId: decodeURIComponent(archiveGetMatch[1]) });
    if (!archive) return sendJson(res, 404, { error: { code: 'ARCHIVE_NOT_FOUND', message: ARCHIVE_ERRORS.ARCHIVE_NOT_FOUND } });
    const exportsList = listArchiveExportsForOwner(user.id, { archiveId: archive.id });
    const credentialsByTask = {};
    for (const task of exportsList) {
      credentialsByTask[task.id] = listCredentialsForOwner({ userId: user.id, exportId: task.id }) || [];
    }
    return sendJson(res, 200, {
      archive,
      exports: exportsList,
      credentialsByTask,
    });
  }
  const archiveExternalCodeMatch = /^\/api\/archives\/([^/]+)\/external-code$/.exec(url.pathname);
  if (archiveExternalCodeMatch && req.method === 'POST') {
    return issueArchiveExternalCodeRoute(req, res, user, archiveExternalCodeMatch[1]);
  }
  const archiveExportsMatch = /^\/api\/archives\/([^/]+)\/exports$/.exec(url.pathname);
  if (archiveExportsMatch && req.method === 'POST') {
    return startArchiveExportRoute(req, res, user, archiveExportsMatch[1]);
  }
  const archiveExportMatch = /^\/api\/archives\/exports\/([^/]+)$/.exec(url.pathname);
  if (archiveExportMatch && req.method === 'GET') {
    const exportId = decodeURIComponent(archiveExportMatch[1]);
    const task = getArchiveExportForOwner({ userId: user.id, exportId });
    if (!task) return sendJson(res, 404, { error: { code: 'EXPORT_NOT_FOUND', message: ARCHIVE_ERRORS.EXPORT_NOT_FOUND } });
    const credentials = listCredentialsForOwner({ userId: user.id, exportId }) || [];
    return sendJson(res, 200, { task, credentials });
  }
  if (archiveExportMatch && req.method === 'POST') {
    const action = url.searchParams.get('action') || '';
    const exportId = decodeURIComponent(archiveExportMatch[1]);
    if (action === 'cancel') return cancelArchiveExportRoute(req, res, user, exportId);
    if (action === 'credential') return issueDownloadCredentialRoute(req, res, user, exportId);
    if (action === 'redownload') return redownloadCredentialRoute(req, res, user, exportId);
  }

  // 归档版本比较报告（办理人：只读）
  if (url.pathname === '/api/archive-comparisons' && req.method === 'POST') {
    return createComparisonRoute(req, res, user);
  }
  if (url.pathname === '/api/archive-comparisons' && req.method === 'GET') {
    const sourceType = url.searchParams.get('sourceType') || '';
    const sourceId = url.searchParams.get('sourceId') || '';
    return sendJson(res, 200, { comparisons: listComparisonsForOwner(user.id, { sourceType, sourceId }) });
  }
  const comparisonGetMatch = /^\/api\/archive-comparisons\/([^/]+)$/.exec(url.pathname);
  if (comparisonGetMatch && req.method === 'GET') {
    const comparison = getComparisonForOwner({
      userId: user.id,
      comparisonId: decodeURIComponent(comparisonGetMatch[1]),
    });
    if (!comparison) return sendJson(res, 404, { error: { code: 'COMPARE_NOT_FOUND', message: COMPARISON_ERRORS.COMPARE_NOT_FOUND } });
    return sendJson(res, 200, { comparison });
  }
  const replayCreateMatch = /^\/api\/archive-comparisons\/([^/]+)\/replays$/.exec(url.pathname);
  if (replayCreateMatch && req.method === 'POST') {
    return createReplayRoute(req, res, user, replayCreateMatch[1]);
  }
  const replayListMatch = /^\/api\/archive-comparisons\/([^/]+)\/replays$/.exec(url.pathname);
  if (replayListMatch && req.method === 'GET') {
    return sendJson(res, 200, {
      replays: listReplaysForOwner(user.id, { comparisonId: decodeURIComponent(replayListMatch[1]) }),
    });
  }

  // 受控重放审阅会话
  if (url.pathname === '/api/replay-sessions' && req.method === 'GET') {
    return sendJson(res, 200, { replays: listReplaysForOwner(user.id) });
  }
  const replayMatch = /^\/api\/replay-sessions\/([^/]+)$/.exec(url.pathname);
  if (replayMatch && req.method === 'GET') {
    const replay = getReplayForOwner({ userId: user.id, replayId: decodeURIComponent(replayMatch[1]) });
    if (!replay) return sendJson(res, 404, { error: { code: 'REPLAY_NOT_FOUND', message: COMPARISON_ERRORS.REPLAY_NOT_FOUND } });
    return sendJson(res, 200, { replay });
  }
  const replayTokenMatch = /^\/api\/replay-sessions\/([^/]+)\/submit-token$/.exec(url.pathname);
  if (replayTokenMatch && req.method === 'POST') {
    return issueReplayTokenRoute(req, res, user, replayTokenMatch[1]);
  }
  const replayOpinionMatch = /^\/api\/replay-sessions\/([^/]+)\/opinions$/.exec(url.pathname);
  if (replayOpinionMatch && req.method === 'POST') {
    return submitReplayOpinionRoute(req, res, user, replayOpinionMatch[1]);
  }
  const replayControlMatch = /^\/api\/replay-sessions\/([^/]+)\/(pause|resume|cancel)$/.exec(url.pathname);
  if (replayControlMatch && req.method === 'POST') {
    return replayControlRoute(req, res, user, replayControlMatch[1], replayControlMatch[2]);
  }

  return sendJson(res, 404, { error: { code: 'NOT_FOUND' } });
}

// 异议处理人侧：只能查看被分配的异议（脱敏回执），执行受理/补充/驳回/确认撤销；
// 以及本人定向收到的提醒/升级通知（确认已读）与一次延期申请
function handleProcessorApi(req, res, user, url) {
  if (url.pathname === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, {
      user: safeUser(user),
      notifications: listNotificationsForUser({ userId: user.id, role: 'processor' }),
      unreadCount: unreadNotificationCount({ userId: user.id, role: 'processor' }),
    });
  }
  // 异议通知留痕（提醒 / 逾期升级 / 延期结论）
  if (url.pathname === '/api/processor/notifications' && req.method === 'GET') {
    return sendJson(res, 200, {
      notifications: listNotificationsForUser({
        userId: user.id,
        role: 'processor',
        status: url.searchParams.get('status') || '',
        kind: url.searchParams.get('kind') || '',
      }),
      unreadCount: unreadNotificationCount({ userId: user.id, role: 'processor' }),
    });
  }
  const notifyReadMatch = /^\/api\/processor\/notifications\/([^/]+)\/read$/.exec(url.pathname);
  if (notifyReadMatch && req.method === 'POST') {
    const result = markObjectionNotificationRead({
      userId: user.id, role: 'processor', notificationId: decodeURIComponent(notifyReadMatch[1]),
    });
    if (!result.ok) {
      return sendJson(res, result.status, { error: { code: result.code, message: result.message } });
    }
    return sendJson(res, 200, { ok: true, notification: result.notification, idempotent: Boolean(result.idempotent) });
  }
  // 延期申请：填写延期原因，每份异议至多一次，主管审批
  const extensionMatch = /^\/api\/processor\/objections\/([^/]+)\/extension$/.exec(url.pathname);
  if (extensionMatch && req.method === 'POST') {
    return processorRequestExtension(req, res, user, extensionMatch[1]);
  }
  if (url.pathname === '/api/processor/objections' && req.method === 'GET') {
    const status = url.searchParams.get('status') || '';
    return sendJson(res, 200, {
      objections: listAssignedObjections(user.id, { status }),
      unreadCount: unreadNotificationCount({ userId: user.id, role: 'processor' }),
    });
  }
  const detailMatch = /^\/api\/processor\/objections\/([^/]+)$/.exec(url.pathname);
  if (detailMatch && req.method === 'GET') {
    const objectionNo = formatObjectionNoInput(decodeURIComponent(detailMatch[1]));
    if (!OBJECTION_NO_PATTERN.test(objectionNo)) {
      return sendJson(res, 400, { error: { code: 'INVALID_OBJECTION_NO', message: '异议编号格式不正确' } });
    }
    const objection = getProcessorObjectionByNo(objectionNo, user.id);
    if (!objection) {
      return sendJson(res, 404, { error: { code: 'OBJECTION_NOT_FOUND', message: '异议不存在或未分配给当前处理人' } });
    }
    objection.escalation = escalationSummaryForObjection(objection.id, { viewer: 'processor', userId: user.id });
    return sendJson(res, 200, { objection });
  }
  const actionMatch = /^\/api\/processor\/objections\/([^/]+)\/(accept|request-supplements|reject|confirm-revocation)$/.exec(url.pathname);
  if (actionMatch && req.method === 'POST') {
    return processorAction(req, res, user, actionMatch[1], actionMatch[2]);
  }
  return sendJson(res, 404, { error: { code: 'NOT_FOUND' } });
}

async function processorRequestExtension(req, res, user, rawObjectionNo) {
  const body = await readJson(req, res);
  if (!body) return;
  const objectionNo = formatObjectionNoInput(decodeURIComponent(rawObjectionNo));
  if (!OBJECTION_NO_PATTERN.test(objectionNo)) {
    return sendJson(res, 400, { error: { code: 'INVALID_OBJECTION_NO', message: '异议编号格式不正确' } });
  }
  const objection = getProcessorObjectionByNo(objectionNo, user.id);
  if (!objection) {
    return sendJson(res, 404, { error: { code: 'OBJECTION_NOT_FOUND', message: '异议不存在或未分配给当前处理人' } });
  }
  const check = validateExtensionReason(body.reason);
  if (!check.ok) return sendJson(res, 400, { error: { code: check.code, message: check.message } });
  const result = requestObjectionExtension({
    userId: user.id, objectionId: objection.id, reason: check.value,
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '延期申请失败' },
      extension: result.extension || null,
    });
  }
  const refreshed = getProcessorObjectionByNo(objectionNo, user.id);
  refreshed.escalation = escalationSummaryForObjection(objection.id, { viewer: 'processor', userId: user.id });
  return sendJson(res, 200, {
    ok: true,
    extension: result.extension,
    objection: refreshed,
    notifications: listNotificationsForUser({ userId: user.id, role: 'processor' }),
  });
}

// 异议主管侧：只读通知留痕（含逾期升级广播）+ 延期审批；不能触碰任何业务数据
function handleSupervisorApi(req, res, user, url) {
  if (url.pathname === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, {
      user: safeUser(user),
      notifications: listNotificationsForUser({ userId: user.id, role: 'supervisor' }),
      unreadCount: listPendingExtensionsForSupervisor().length,
    });
  }
  if (url.pathname === '/api/supervisor/notifications' && req.method === 'GET') {
    return sendJson(res, 200, {
      notifications: listNotificationsForUser({
        userId: user.id,
        role: 'supervisor',
        status: url.searchParams.get('status') || '',
        kind: url.searchParams.get('kind') || '',
      }),
      pendingExtensions: listPendingExtensionsForSupervisor().length,
    });
  }
  const notifyReadMatch = /^\/api\/supervisor\/notifications\/([^/]+)\/read$/.exec(url.pathname);
  if (notifyReadMatch && req.method === 'POST') {
    const result = markObjectionNotificationRead({
      userId: user.id, role: 'supervisor', notificationId: decodeURIComponent(notifyReadMatch[1]),
    });
    if (!result.ok) {
      return sendJson(res, result.status, { error: { code: result.code, message: result.message } });
    }
    return sendJson(res, 200, { ok: true, notification: result.notification, idempotent: Boolean(result.idempotent) });
  }
  if (url.pathname === '/api/supervisor/extensions' && req.method === 'GET') {
    const status = url.searchParams.get('status') || '';
    return sendJson(res, 200, { extensions: listExtensionsForSupervisor({ status }) });
  }
  // 可版本化工作日历（主管维护）：版本清单 / 当前生效版本
  if (url.pathname === '/api/supervisor/working-calendars' && req.method === 'GET') {
    return sendJson(res, 200, {
      versions: listCalendarVersions(),
      current: getCurrentCalendarVersion(),
    });
  }
  const calendarGetMatch = /^\/api\/supervisor\/working-calendars\/([^/]+)$/.exec(url.pathname);
  if (calendarGetMatch && req.method === 'GET') {
    const calendar = getCalendarVersionById(decodeURIComponent(calendarGetMatch[1]));
    if (!calendar) return sendJson(res, 404, { error: { code: 'CALENDAR_VERSION_NOT_FOUND', message: '日历版本不存在' } });
    return sendJson(res, 200, { calendar });
  }
  // 发布新版本（只追加；发布即成为当前生效版本，不影响任何在办异议）
  if (url.pathname === '/api/supervisor/working-calendars' && req.method === 'POST') {
    return publishCalendarRoute(req, res, user);
  }
  // 迁移预览（可选 targetVersionId；默认当前生效版本）
  if (url.pathname === '/api/supervisor/calendar-migrations/preview' && req.method === 'POST') {
    return createCalendarPreviewRoute(req, res, user);
  }
  if (url.pathname === '/api/supervisor/calendar-migrations' && req.method === 'GET') {
    return sendJson(res, 200, { previews: listMigrationPreviews() });
  }
  const previewGetMatch = /^\/api\/supervisor\/calendar-migrations\/([^/]+)$/.exec(url.pathname);
  if (previewGetMatch && req.method === 'GET') {
    const preview = getMigrationPreview(decodeURIComponent(previewGetMatch[1]));
    if (!preview) return sendJson(res, 404, { error: { code: 'MIGRATION_PREVIEW_NOT_FOUND', message: '迁移预览不存在' } });
    return sendJson(res, 200, { preview });
  }
  // 按预览版本确认迁移（必须回传预览 digest；逾期/终结异议不会迁移）
  const previewApplyMatch = /^\/api\/supervisor\/calendar-migrations\/([^/]+)\/apply$/.exec(url.pathname);
  if (previewApplyMatch && req.method === 'POST') {
    return applyCalendarPreviewRoute(req, res, user, previewApplyMatch[1]);
  }
  const extensionMatch = /^\/api\/supervisor\/extensions\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
  if (extensionMatch && req.method === 'POST') {
    return supervisorDecideExtension(req, res, user, extensionMatch[1], extensionMatch[2]);
  }
  return sendJson(res, 404, { error: { code: 'NOT_FOUND' } });
}

async function supervisorDecideExtension(req, res, user, rawExtensionId, decision) {
  const extensionId = decodeURIComponent(rawExtensionId);
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(extensionId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_EXTENSION_ID', message: '延期申请标识不正确' } });
  }
  const extension = getExtensionForSupervisor(extensionId);
  if (!extension) return sendJson(res, 404, { error: { code: 'EXTENSION_NOT_FOUND', message: '延期申请不存在' } });
  const body = await readJson(req, res);
  if (!body) return;
  // 拒绝必须填写理由；批准可填写说明
  const check = validateExtensionDecision(body.note || body.reason, { required: decision === 'reject' });
  if (!check.ok) return sendJson(res, 400, { error: { code: check.code, message: check.message } });
  const result = decideObjectionExtension({
    userId: user.id, extensionId, decision: decision === 'approve' ? 'approve' : 'reject', note: check.value,
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '决议失败' },
      extension: result.extension || null,
    });
  }
  return sendJson(res, 200, {
    ok: true,
    extension: getExtensionForSupervisor(extensionId),
    newDeadlineAt: result.newDeadlineAt,
    pendingExtensions: listPendingExtensionsForSupervisor(),
  });
}

// 发布工作日历新版本：校验由 store 内 parseCalendarConfig 完成，错误码透传
async function publishCalendarRoute(req, res, user) {
  const body = await readJson(req, res);
  if (!body) return;
  const result = publishCalendarVersion({
    userId: user.id,
    config: body.config || body,
    note: String(body.note || '').trim(),
  });
  if (!result.ok) {
    return sendJson(res, result.status || 400, { error: { code: result.code, message: result.message } });
  }
  return sendJson(res, 200, {
    ok: true,
    calendar: result.calendar,
    versions: listCalendarVersions(),
    current: getCurrentCalendarVersion(),
  });
}

// 生成迁移预览：只受影响的在办异议入清单，逾期/终态明确排除并说明
async function createCalendarPreviewRoute(req, res, user) {
  const body = await readJson(req, res);
  if (!body) return;
  const targetVersionId = String(body.targetVersionId || body.targetCalendarVersionId || '').trim();
  const result = previewObjectionCalendarMigration({
    userId: user.id,
    targetVersionId: targetVersionId || null,
    note: String(body.note || '').trim(),
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '预览失败' },
    });
  }
  return sendJson(res, 200, { ok: true, preview: result.preview });
}

// 按预览版本确认迁移：digest 不匹配 / 预览后清单变化 → 409，要求重新预览
async function applyCalendarPreviewRoute(req, res, user, rawPreviewId) {
  const previewId = decodeURIComponent(rawPreviewId);
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(previewId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_PREVIEW_ID', message: '预览标识不正确' } });
  }
  const body = await readJson(req, res);
  if (!body) return;
  const digest = String(body.digest || '').trim();
  if (!digest) {
    return sendJson(res, 400, { error: { code: 'DIGEST_REQUIRED', message: '确认迁移必须回传预览摘要' } });
  }
  const result = confirmObjectionCalendarMigration({ userId: user.id, previewId, digest });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: {
        code: result.code,
        message: result.message || '迁移失败',
      },
      conflicts: result.conflicts || null,
    });
  }
  return sendJson(res, 200, {
    ok: true,
    migratedCount: result.migratedCount,
    migrated: result.migrated,
    preview: result.preview,
    previews: listMigrationPreviews(),
  });
}

const PROCESSOR_ACTIONS = {
  accept: acceptReceiptObjection,
  'request-supplements': requestObjectionSupplements,
  reject: rejectReceiptObjection,
  'confirm-revocation': confirmObjectionRevocation,
};

async function processorAction(req, res, user, rawObjectionNo, action) {
  const body = await readJson(req, res);
  if (!body) return;
  const objectionNo = formatObjectionNoInput(decodeURIComponent(rawObjectionNo));
  if (!OBJECTION_NO_PATTERN.test(objectionNo)) {
    return sendJson(res, 400, { error: { code: 'INVALID_OBJECTION_NO', message: '异议编号格式不正确' } });
  }
  const objection = getProcessorObjectionByNo(objectionNo, user.id);
  if (!objection) {
    return sendJson(res, 404, { error: { code: 'OBJECTION_NOT_FOUND', message: '异议不存在或未分配给当前处理人' } });
  }
  const params = { userId: user.id, objectionId: objection.id };
  if (action === 'reject') {
    const check = validateRejectReason(body.reason);
    if (!check.ok) return sendJson(res, 400, { error: { code: check.code, message: check.message } });
    params.reason = check.value;
  } else if (action === 'request-supplements') {
    const check = validateSupplementNote(body.note || body.reason, { required: true });
    if (!check.ok) return sendJson(res, 400, { error: { code: check.code, message: check.message } });
    params.note = check.value;
  } else if (action === 'confirm-revocation') {
    params.reason = String(body.reason || body.note || '').trim().slice(0, 300);
  } else {
    params.reason = String(body.reason || '').trim().slice(0, 300);
  }
  const result = PROCESSOR_ACTIONS[action](params);
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '处理失败' },
      objection: result.objection || null,
    });
  }
  return sendJson(res, 200, {
    ok: true,
    objection: result.objection,
    receiptStatus: result.receiptStatus,
    objections: listAssignedObjections(user.id),
  });
}

// 审计员侧：只能查看授权归档的脱敏视图、来源关系与摘要链校验结果
function handleAuditorArchiveApi(req, res, user, url) {
  // 撤销异议审计记录：审计角色按权限可查看全部异议的完整审计记录
  // （含未脱敏冻结快照、文本说明原文与完整处理历史；只读，无任何写接口）
  if (url.pathname === '/api/auditor/receipt-objections' && req.method === 'GET') {
    const receiptNo = url.searchParams.get('receiptNo') || '';
    const status = url.searchParams.get('status') || '';
    return sendJson(res, 200, { objections: listAllObjectionsForAuditor({ receiptNo, status }) });
  }
  const objectionMatch = /^\/api\/auditor\/receipt-objections\/([^/]+)$/.exec(url.pathname);
  if (objectionMatch && req.method === 'GET') {
    const objectionNo = formatObjectionNoInput(decodeURIComponent(objectionMatch[1]));
    if (!OBJECTION_NO_PATTERN.test(objectionNo)) {
      return sendJson(res, 400, { error: { code: 'INVALID_OBJECTION_NO', message: '异议编号格式不正确' } });
    }
    const objection = getAuditorObjectionByNo(objectionNo);
    if (!objection) return sendJson(res, 404, { error: { code: 'OBJECTION_NOT_FOUND', message: '异议不存在' } });
    // 完整通知留痕与延期审批记录（通知负载本身即不含证件号/完整地址/完整手机号）
    objection.escalation = escalationSummaryForObjection(objection.id, { viewer: 'auditor' });
    return sendJson(res, 200, { objection });
  }
  // 异议通知完整审计记录（提醒 / 逾期升级 / 延期通知，按接收角色与类型过滤）
  if (url.pathname === '/api/auditor/receipt-objection-notifications' && req.method === 'GET') {
    return sendJson(res, 200, {
      notifications: listAllNotificationsForAuditor({
        kind: url.searchParams.get('kind') || '',
        audience: url.searchParams.get('audience') || '',
        status: url.searchParams.get('status') || '',
        objectionNo: url.searchParams.get('objectionNo') || '',
      }),
    });
  }
  // 延期申请与主管决议完整记录
  if (url.pathname === '/api/auditor/receipt-objection-extensions' && req.method === 'GET') {
    return sendJson(res, 200, {
      extensions: listAllExtensionsForAuditor({ status: url.searchParams.get('status') || '' }),
    });
  }
  // 可版本化工作日历：审计员可查看全部已发布版本（只读）
  if (url.pathname === '/api/auditor/working-calendars' && req.method === 'GET') {
    return sendJson(res, 200, {
      versions: listCalendarVersions(),
      current: getCurrentCalendarVersion(),
    });
  }
  // 日历迁移留痕（可按异议编号过滤；只读）
  if (url.pathname === '/api/auditor/calendar-migrations' && req.method === 'GET') {
    const objectionNo = url.searchParams.get('objectionNo') || '';
    let objectionId = null;
    if (objectionNo) {
      const found = getAuditorObjectionByNo(objectionNo);
      if (!found) return sendJson(res, 404, { error: { code: 'OBJECTION_NOT_FOUND', message: '异议不存在' } });
      objectionId = found.id;
    }
    return sendJson(res, 200, { migrations: listAllCalendarMigrationsForAuditor({ objectionId }) });
  }
  if (url.pathname === '/api/auditor/archives' && req.method === 'GET') {
    return sendJson(res, 200, { archives: listArchivesForAuditor(user.id) });
  }
  // 比较报告：只有同时被两个版本的权限快照授权时可见；只给脱敏条目，不含任何重放意见
  if (url.pathname === '/api/auditor/comparisons' && req.method === 'GET') {
    return sendJson(res, 200, { comparisons: listComparisonsForAuditor(user.id) });
  }
  const comparisonMatch = /^\/api\/auditor\/comparisons\/([^/]+)$/.exec(url.pathname);
  if (comparisonMatch && req.method === 'GET') {
    const comparison = getComparisonForAuditor({
      userId: user.id,
      comparisonId: decodeURIComponent(comparisonMatch[1]),
    });
    if (!comparison) return sendJson(res, 404, { error: { code: 'COMPARE_NOT_FOUND', message: COMPARISON_ERRORS.COMPARE_NOT_FOUND } });
    if (comparison.forbidden) {
      return sendJson(res, 403, { error: { code: 'COMPARE_VIEW_FORBIDDEN', message: COMPARISON_ERRORS.COMPARE_VIEW_FORBIDDEN } });
    }
    return sendJson(res, 200, { comparison });
  }
  const match = /^\/api\/auditor\/archives\/([^/]+)$/.exec(url.pathname);
  if (match && req.method === 'GET') {
    const archive = getArchiveForAuditor({ userId: user.id, archiveId: decodeURIComponent(match[1]) });
    if (!archive) return sendJson(res, 404, { error: { code: 'ARCHIVE_NOT_FOUND', message: ARCHIVE_ERRORS.ARCHIVE_NOT_FOUND } });
    if (archive.forbidden) {
      return sendJson(res, 403, { error: { code: 'ARCHIVE_VIEW_FORBIDDEN', message: ARCHIVE_ERRORS.ARCHIVE_VIEW_FORBIDDEN } });
    }
    return sendJson(res, 200, { archive });
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
  // 审计员/处理人不触发办理工作流创建，登录响应只携带身份与 CSRF
  const extra = (user.role === 'auditor' || user.role === 'processor') ? {} : getStateForUser(user.id);
  return sendJson(res, 200, {
    user: safeUser(user),
    csrfToken: session.csrf,
    ...extra,
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
// 回执撤销与异议处理：办理人侧（发起、查看、补充材料）
// ---------------------------------------------------------------------------

async function createObjection(req, res, user) {
  const body = await readJson(req, res);
  if (!body) return;
  const receiptNo = formatReceiptNoInput(String(body.receiptNo || ''));
  if (!RECEIPT_NO_PATTERN.test(receiptNo)) {
    return sendJson(res, 400, { error: { code: 'INVALID_RECEIPT_NO', message: '回执编号格式不正确' } });
  }
  const reasonCheck = validateObjectionReason(body.reason);
  if (!reasonCheck.ok) {
    return sendJson(res, 400, { error: { code: reasonCheck.code, message: reasonCheck.message } });
  }
  const attachmentCheck = parseTextAttachment(body.attachment);
  if (!attachmentCheck.ok) {
    return sendJson(res, 400, { error: { code: attachmentCheck.code, message: attachmentCheck.message } });
  }
  const result = createReceiptObjection({
    userId: user.id,
    receiptNo,
    reason: reasonCheck.value,
    attachment: attachmentCheck.value,
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '无法发起异议' },
      objectionNo: result.objectionNo || null,
      timeline: getTimelineForUser(user.id),
    });
  }
  const state = getStateForUser(user.id);
  return sendJson(res, 200, {
    ok: true,
    objection: result.objection,
    records: state.records,
    timeline: state.timeline,
    receiptObjections: state.receiptObjections,
  });
}

async function supplementObjection(req, res, user, rawObjectionNo) {
  const body = await readJson(req, res);
  if (!body) return;
  const objectionNo = formatObjectionNoInput(decodeURIComponent(rawObjectionNo));
  if (!OBJECTION_NO_PATTERN.test(objectionNo)) {
    return sendJson(res, 400, { error: { code: 'INVALID_OBJECTION_NO', message: '异议编号格式不正确' } });
  }
  const existing = getOwnerObjectionByNo(objectionNo, user.id);
  if (!existing) {
    return sendJson(res, 404, { error: { code: 'OBJECTION_NOT_FOUND', message: '异议不存在或不属于当前账号' } });
  }
  const attachmentCheck = parseTextAttachment(body.attachment);
  if (!attachmentCheck.ok) {
    return sendJson(res, 400, { error: { code: attachmentCheck.code, message: attachmentCheck.message } });
  }
  const noteCheck = validateSupplementNote(body.note, { required: true });
  if (!noteCheck.ok) {
    return sendJson(res, 400, { error: { code: noteCheck.code, message: noteCheck.message } });
  }
  const result = supplementReceiptObjection({
    userId: user.id,
    objectionId: existing.id,
    note: noteCheck.value,
    supplement: attachmentCheck.value,
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '补充材料失败' },
      objection: result.objection || null,
    });
  }
  const state = getStateForUser(user.id);
  return sendJson(res, 200, {
    ok: true,
    objection: result.objection,
    timeline: state.timeline,
    receiptObjections: state.receiptObjections,
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
    parked: Boolean(result.parked),
    packageStatus: result.packageStatus,
    pkg: result.pkg,
    records: state.records,
    timeline: state.timeline,
    mediationPackages: state.mediationPackages,
    correction: state.correction,
  });
}

// ---------------------------------------------------------------------------
// 案件组（跨包冲突协调）：办理人侧
// ---------------------------------------------------------------------------

function caseGroupConfigFromBody(body, memberPackageIds) {
  const maxMinutes = Math.floor(config.reviewInviteMaxTtlMs / 60000);
  const minMinutes = Math.max(1, Math.ceil(config.reviewInviteMinTtlMs / 60000));
  return parseCaseGroupConfigInput(body, { memberPackageIds, minMinutes, maxMinutes });
}

async function createCaseGroupRoute(req, res, user) {
  const body = await readJson(req, res);
  if (!body) return;
  const parsed = parseCaseGroupCreateInput(body);
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });
  const result = createCaseGroup({
    userId: user.id,
    anchorPackageId: parsed.value.anchorPackageId,
    note: parsed.value.note,
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '创建案件组失败', detail: result.detail || '' },
      group: result.group || null,
    });
  }
  const state = getStateForUser(user.id);
  return sendJson(res, 200, {
    ok: true,
    caseGroup: result.group,
    timeline: state.timeline,
    caseGroups: state.caseGroups,
  });
}

async function addCaseGroupMemberRoute(req, res, user, rawGroupId) {
  const body = await readJson(req, res);
  if (!body) return;
  const groupId = decodeURIComponent(rawGroupId);
  const packageId = String(body.packageId || '');
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(groupId) || !/^[A-Za-z0-9_-]{8,200}$/.test(packageId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_ID', message: '案件组或调解包标识不正确' } });
  }
  const result = addCaseGroupMember({ userId: user.id, groupId, packageId });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: {
        code: result.code,
        message: result.message || CASE_GROUP_ERRORS[result.code] || '成员包未通过冲突检查，不能加入案件组',
        detail: result.detail || '',
      },
      group: result.group || null,
    });
  }
  const state = getStateForUser(user.id);
  return sendJson(res, 200, {
    ok: true,
    caseGroup: result.group,
    timeline: state.timeline,
    caseGroups: state.caseGroups,
  });
}

async function configureCaseGroupRoute(req, res, user, rawGroupId) {
  const body = await readJson(req, res);
  if (!body) return;
  const groupId = decodeURIComponent(rawGroupId);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(groupId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_ID' } });
  }
  const current = getCaseGroupForOwner({ userId: user.id, groupId });
  if (!current) {
    return sendJson(res, 404, { error: { code: 'CASE_GROUP_NOT_FOUND', message: CASE_GROUP_ERRORS.CASE_GROUP_NOT_FOUND } });
  }
  const memberPackageIds = current.members.map((member) => member.packageId);
  const parsed = caseGroupConfigFromBody(body, memberPackageIds);
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });
  const result = configureCaseGroup({ userId: user.id, groupId, config: parsed.value });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '保存案件组配置失败' },
      caseGroup: result.group || null,
    });
  }
  return sendJson(res, 200, { ok: true, caseGroup: result.group });
}

async function startCaseGroupRoute(req, res, user, rawGroupId) {
  const body = await readJson(req, res);
  if (!body) return;
  const groupId = decodeURIComponent(rawGroupId);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(groupId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_ID' } });
  }
  // 允许在启动请求中一并提交最终配置（仍须 collecting）
  if (body && body.config) {
    const current = getCaseGroupForOwner({ userId: user.id, groupId });
    if (!current) {
      return sendJson(res, 404, { error: { code: 'CASE_GROUP_NOT_FOUND', message: CASE_GROUP_ERRORS.CASE_GROUP_NOT_FOUND } });
    }
    const memberPackageIds = current.members.map((member) => member.packageId);
    const parsed = caseGroupConfigFromBody(body.config, memberPackageIds);
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });
    const configured = configureCaseGroup({ userId: user.id, groupId, config: parsed.value });
    if (!configured.ok) {
      return sendJson(res, configured.status || 409, {
        error: { code: configured.code, message: configured.message || '保存案件组配置失败' },
        caseGroup: configured.group || null,
      });
    }
  }
  const result = startCaseGroup({ userId: user.id, groupId });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '启动案件组失败' },
      caseGroup: result.group || null,
    });
  }
  const state = getStateForUser(user.id);
  return sendJson(res, 200, {
    ok: true,
    caseGroup: result.group,
    timeline: state.timeline,
    caseGroups: state.caseGroups,
  });
}

async function cancelCaseGroupRoute(req, res, user, rawGroupId) {
  const body = await readJson(req, res);
  if (!body) return;
  const groupId = decodeURIComponent(rawGroupId);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(groupId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_ID' } });
  }
  const result = cancelCaseGroup({ userId: user.id, groupId, reason: String(body.reason || '') });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '取消案件组失败' },
      caseGroup: result.group || null,
    });
  }
  const state = getStateForUser(user.id);
  return sendJson(res, 200, { ok: true, caseGroup: result.group, timeline: state.timeline, caseGroups: state.caseGroups });
}

// ---------------------------------------------------------------------------
// 可验证审计归档：办理人侧
// ---------------------------------------------------------------------------

async function createArchiveRoute(req, res, user) {
  const body = await readJson(req, res);
  if (!body) return;
  const parsed = parseArchiveCreateInput(body);
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });
  const auditorUsers = userQueries.listByRole('auditor');
  const grantsParsed = parseAuditorGrants(body, auditorUsers);
  if (grantsParsed.error) return sendJson(res, 400, { error: grantsParsed.error });
  const result = createAuditArchive({
    userId: user.id,
    sourceType: parsed.value.sourceType,
    sourceId: parsed.value.sourceId,
    note: parsed.value.note,
    auditorGrants: grantsParsed.value,
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '归档生成失败', detail: result.rejection || null },
      rejection: result.rejection || null,
    });
  }
  const state = getStateForUser(user.id);
  return sendJson(res, 200, {
    ok: true,
    archive: result.archive,
    archives: state.archives,
    archiveRejections: state.archiveRejections,
  });
}

async function issueArchiveExternalCodeRoute(req, res, user, rawArchiveId) {
  const body = await readJson(req, res);
  if (!body) return;
  const archiveId = decodeURIComponent(rawArchiveId);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(archiveId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_ID' } });
  }
  const result = issueExternalCode({ userId: user.id, archiveId });
  if (!result.ok) {
    return sendJson(res, result.status || 409, { error: { code: result.code, message: result.message || '核验码生成失败' } });
  }
  // 完整核验码只在创建当次返回一次（与回执核验码同等对待）
  const url = `/archive-verify?a=${encodeURIComponent(archiveId)}`;
  return sendJson(res, 200, { ok: true, code: result.code, url, expiresAt: result.expiresAt });
}

async function startArchiveExportRoute(req, res, user, rawArchiveId) {
  const body = await readJson(req, res);
  if (!body) return;
  const archiveId = decodeURIComponent(rawArchiveId);
  const idempotencyKey = String(body.idempotencyKey || '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(archiveId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_ID' } });
  }
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
    return sendJson(res, 400, { error: { code: 'INVALID_IDEMPOTENCY_KEY', message: '导出必须携带 8-100 位幂等键' } });
  }
  const result = startArchiveExport({ userId: user.id, archiveId, idempotencyKey });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || ARCHIVE_ERRORS[result.code] || '启动导出失败' },
      task: result.task || null,
    });
  }
  // 后台任务由定时扫描推进（默认 1s 内开始），这里不做同步处理，
  // 以保留“两个页面并发启动只有一个进入进行中”的真实竞态语义。
  const task = getArchiveExportForOwner({ userId: user.id, exportId: result.task.id });
  return sendJson(res, 200, { ok: true, replay: Boolean(result.replay), task });
}

async function cancelArchiveExportRoute(req, res, user, rawExportId) {
  const body = await readJson(req, res);
  if (!body) return;
  const exportId = decodeURIComponent(rawExportId);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(exportId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_ID' } });
  }
  const result = cancelArchiveExport({ userId: user.id, exportId });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || ARCHIVE_ERRORS[result.code] || '取消失败' },
      task: result.task || null,
    });
  }
  return sendJson(res, 200, { ok: true, task: result.task });
}

async function issueDownloadCredentialRoute(req, res, user, rawExportId) {
  const exportId = decodeURIComponent(rawExportId);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(exportId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_ID' } });
  }
  const result = issueDownloadCredential({ userId: user.id, exportId });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || ARCHIVE_ERRORS[result.code] || '凭证生成失败' },
    });
  }
  return sendJson(res, 200, {
    ok: true,
    credential: result.credential,
    expiresAt: result.expiresAt,
    fileVersion: result.fileVersion,
    fileDigest: result.fileDigest,
  });
}

// 重新下载：对已完成任务再签发一张新的一次性凭证（旧凭证是否已用不影响新凭证）
async function redownloadCredentialRoute(req, res, user, rawExportId) {
  const task = getArchiveExportForOwner({ userId: user.id, exportId: decodeURIComponent(rawExportId) });
  if (!task) return sendJson(res, 404, { error: { code: 'EXPORT_NOT_FOUND', message: ARCHIVE_ERRORS.EXPORT_NOT_FOUND } });
  if (task.status !== 'completed') {
    return sendJson(res, 409, {
      error: {
        code: task.status === 'expired' ? 'EXPORT_TASK_EXPIRED' : 'EXPORT_NOT_COMPLETED',
        message: task.status === 'expired' ? ARCHIVE_ERRORS.EXPORT_TASK_EXPIRED : ARCHIVE_ERRORS.EXPORT_NOT_COMPLETED,
      },
      task,
    });
  }
  return issueDownloadCredentialRoute(req, res, user, rawExportId);
}

// ---------------------------------------------------------------------------
// 归档版本比较报告：办理人侧（只读；不改写任一归档）
// ---------------------------------------------------------------------------

async function createComparisonRoute(req, res, user) {
  const body = await readJson(req, res);
  if (!body) return;
  const parsed = parseComparisonCreateInput(body);
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });
  const result = createArchiveComparison({
    userId: user.id,
    baseArchiveId: parsed.value.baseArchiveId,
    targetArchiveId: parsed.value.targetArchiveId,
    note: parsed.value.note,
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || COMPARISON_ERRORS[result.code] || '比较报告生成失败' },
      detail: result.detail || null,
    });
  }
  return sendJson(res, 200, { ok: true, comparison: result.comparison });
}

function replayTtlRange() {
  const maxMinutes = Math.floor(config.replayMaxTtlMs / 60000);
  const minMinutes = Math.max(1, Math.ceil(config.replayMinTtlMs / 60000));
  return { minMinutes, maxMinutes };
}

async function createReplayRoute(req, res, user, rawComparisonId) {
  const comparisonId = decodeURIComponent(rawComparisonId);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(comparisonId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_ID' } });
  }
  const body = await readJson(req, res);
  if (!body) return;
  const { minMinutes, maxMinutes } = replayTtlRange();
  const parsed = parseReplayCreateInput(body, { minMinutes, maxMinutes });
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });
  const result = createReplaySession({
    userId: user.id,
    comparisonId,
    entryKeys: parsed.value.entryKeys,
    ttlMs: parsed.value.ttlMinutes * 60000,
    note: parsed.value.note,
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || COMPARISON_ERRORS[result.code] || '创建重放会话失败' },
      entryKey: result.entryKey,
      verification: result.verification || null,
      replay: null,
    });
  }
  // 创建即签发第一枚一次性提交令牌，页面刷新后可再取新令牌（旧令牌作废）
  const token = issueReplaySubmitToken({ userId: user.id, replayId: result.replay.id });
  return sendJson(res, 200, {
    ok: true,
    replay: result.replay,
    submitToken: token.ok ? token.submitToken : null,
    submitTokenExpiresAt: token.ok ? token.expiresAt : null,
  });
}

async function issueReplayTokenRoute(req, res, user, rawReplayId) {
  const replayId = decodeURIComponent(rawReplayId);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(replayId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_ID' } });
  }
  const result = issueReplaySubmitToken({ userId: user.id, replayId });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || COMPARISON_ERRORS[result.code] || '获取提交令牌失败' },
    });
  }
  return sendJson(res, 200, {
    ok: true,
    submitToken: result.submitToken,
    expiresAt: result.expiresAt,
    ttlMs: result.ttlMs,
    version: result.version,
    replayStatus: result.replayStatus,
  });
}

async function submitReplayOpinionRoute(req, res, user, rawReplayId) {
  const replayId = decodeURIComponent(rawReplayId);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(replayId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_ID' } });
  }
  const body = await readJson(req, res);
  if (!body) return;
  const parsed = parseReplayOpinionInput(body);
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });
  const value = parsed.value;
  const result = submitReplayOpinion({
    userId: user.id,
    replayId,
    entryKey: value.entryKey,
    kind: value.kind,
    comment: value.comment,
    reason: value.reason,
    idempotencyKey: value.idempotencyKey,
    submitToken: value.submitToken,
    expectedVersion: value.expectedVersion,
    requestText: value.requestText,
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || COMPARISON_ERRORS[result.code] || '提交失败' },
      replay: result.replay === false ? false : undefined,
      currentVersion: result.currentVersion,
      existingKind: result.existingKind,
    });
  }
  // 令牌一次性消费后，为下一次写操作补发一枚新令牌（旧令牌已被本次请求消费）
  const nextToken = issueReplaySubmitToken({ userId: user.id, replayId });
  return sendJson(res, 200, {
    ok: true,
    replay: Boolean(result.replay),
    opinion: result.opinion,
    version: result.version,
    nextSubmitToken: nextToken.ok ? nextToken.submitToken : null,
    nextSubmitTokenExpiresAt: nextToken.ok ? nextToken.expiresAt : null,
  });
}

async function replayControlRoute(req, res, user, rawReplayId, action) {
  const replayId = decodeURIComponent(rawReplayId);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(replayId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_ID' } });
  }
  const body = await readJson(req, res);
  if (!body) return;
  const parsed = parseReplayControlInput(body);
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });
  const args = {
    userId: user.id,
    replayId,
    submitToken: parsed.value.submitToken,
    expectedVersion: parsed.value.expectedVersion,
    reason: parsed.value.reason,
  };
  const result = action === 'pause' ? pauseReplaySession(args)
    : action === 'resume' ? resumeReplaySession(args)
      : cancelReplaySession(args);
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || COMPARISON_ERRORS[result.code] || '操作失败' },
      currentVersion: result.currentVersion,
      verification: result.verification || null,
    });
  }
  // 暂停后不再签发写令牌；恢复成功后补发新令牌；取消后只读，不签发
  let nextToken = null;
  if (action === 'resume') nextToken = issueReplaySubmitToken({ userId: user.id, replayId });
  return sendJson(res, 200, {
    ok: true,
    replay: result.replay,
    verification: result.verification || result.replay?.verification || null,
    nextSubmitToken: nextToken?.ok ? nextToken.submitToken : null,
    nextSubmitTokenExpiresAt: nextToken?.ok ? nextToken.expiresAt : null,
  });
}

// 免登录外部核验：一次性核验码，只返回事件数量/时间范围/摘要链连续性/最终状态
async function archiveExternalVerify(req, res) {
  const clientIp = req.socket.remoteAddress || 'unknown';
  const limitKey = `archive-external-verify:${clientIp}`;
  const rate = { windowMs: config.verifyRateWindowMs, max: config.verifyRateMax };
  const preview = peekRateLimit(limitKey, rate);
  if (!preview.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(preview.retryAfterMs / 1000))));
    return sendJson(res, 429, { error: { code: 'TOO_MANY_REQUESTS', message: '核验尝试过于频繁，请稍后再试' } });
  }
  const body = await readJson(req, res);
  if (!body) return;
  const code = String(body.code || '').trim();
  const archiveId = String(body.archiveId || '').trim();
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(code) || (archiveId && !/^[A-Za-z0-9_-]{8,200}$/.test(archiveId))) {
    recordFailure(limitKey, rate);
    return sendJson(res, 400, { error: { code: 'INVALID_INPUT', message: '请输入格式正确的核验码' } });
  }
  const result = consumeExternalCode({ rawCode: code, expectedArchiveId: archiveId, clientIp });
  if (!result.ok) {
    recordFailure(limitKey, rate);
    return sendJson(res, result.status, { error: { code: result.code, message: result.message || ARCHIVE_ERRORS[result.code] || '核验失败' } });
  }
  return sendJson(res, 200, { ok: true, archive: result.view });
}

// 一次性下载凭证兑换导出文件（GET，免登录；凭证本身即授权）
async function archiveCredentialDownload(req, res, url, rawExportId) {
  const exportId = decodeURIComponent(rawExportId);
  const credential = String(url.searchParams.get('credential') || '').trim();
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(exportId) || !/^[A-Za-z0-9_-]{20,512}$/.test(credential)) {
    return sendJson(res, 400, { error: { code: 'INVALID_INPUT', message: '下载链接不完整' } });
  }
  const result = redeemDownloadCredential({ rawCode: credential, clientIp: req.socket.remoteAddress || 'unknown' });
  if (!result.ok) {
    return sendJson(res, result.status, { error: { code: result.code, message: result.message || ARCHIVE_ERRORS[result.code] || '下载被拒绝' } });
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
    'X-File-Version': String(result.fileVersion),
    'X-Content-Digest': `sha-256=${result.fileDigest}`,
    ...securityHeaders(),
  });
  res.end(result.content);
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
let archiveSweepTimer = null;
function stopArchiveSweep() {
  if (archiveSweepTimer) clearInterval(archiveSweepTimer);
  archiveSweepTimer = null;
}
function startBatchTimeoutSweep() {
  if (batchSweepTimer || process.env.NO_BATCH_SWEEP === '1') {
    // 即使关闭批次扫描（如测试环境），异议调度仍需独立注册与启动恢复
    startObjectionSweep();
    return;
  }
  // 启动时先恢复一次：服务在限时内重启后，到点的批次阶段/申诉回合/调解包层级/案件组仍会被落定
  try { sweepBatchTimeouts(); } catch { /* 记录但不阻塞启动 */ }
  try { sweepAppealTimeouts(); } catch { /* 同上 */ }
  try { sweepMediationTimeouts(); } catch { /* 同上 */ }
  try { recoverCaseGroupsOnStartup(); } catch { /* 案件组成员状态对齐 */ }
  // 归档导出：未完成任务从持久化的分块进度继续，完成/过期状态重新对齐
  try { recoverArchiveExportsOnStartup(); } catch { /* 归档导出恢复 */ }
  // 重放会话过期落定（只读恢复不依赖扫描，扫描只负责把到期会话转为 expired）
  try { sweepReplaySessions(); } catch { /* 重放过期恢复 */ }
  batchSweepTimer = setInterval(() => {
    try { sweepBatchTimeouts(); } catch (error) { console.error('batch timeout sweep failed', error); }
    try { sweepAppealTimeouts(); } catch (error) { console.error('appeal timeout sweep failed', error); }
    try { sweepMediationTimeouts(); } catch (error) { console.error('mediation timeout sweep failed', error); }
    try { sweepCaseGroupTimeouts(); } catch (error) { console.error('case group timeout sweep failed', error); }
  }, BATCH_TIMEOUT_SWEEP_MS);
  batchSweepTimer.unref?.();
  // 归档导出后台任务：分块推进、断点续传与过期清理（间隔可经 ARCHIVE_SWEEP_MS 调整）
  archiveSweepTimer = setInterval(() => {
    try { sweepArchiveExports(); } catch (error) { console.error('archive export sweep failed', error); }
    try { sweepReplaySessions(); } catch (error) { console.error('replay session sweep failed', error); }
  }, config.archiveSweepMs);
  archiveSweepTimer.unref?.();
  startObjectionSweep();
}

// 异议提醒/逾期升级/待发送通知：独立于批次扫描注册，重复调用幂等。
// 启动恢复先扫一次——重启期间错过的提醒/逾期升级全部补落，
// 唯一索引保证不会与重启前的记录重复。
let objectionSweepTimer = null;
function startObjectionSweep() {
  try { sweepObjectionNotifications(); } catch (error) {
    console.error('objection escalation sweep failed', error);
  }
  if (objectionSweepTimer || process.env.NO_OBJECTION_SWEEP === '1') return;
  objectionSweepTimer = setInterval(() => {
    try { sweepObjectionNotifications(); } catch (error) {
      console.error('objection escalation sweep failed', error);
    }
  }, config.objectionSweepMs);
  objectionSweepTimer.unref?.();
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
  return { id: user.id, username: user.username, displayName: user.display_name || user.displayName, role: user.role || 'handler' };
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

export { server, startBatchTimeoutSweep, stopArchiveSweep as stopArchiveExportSweep };
