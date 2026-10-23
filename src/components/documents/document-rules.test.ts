import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bytesMatchKind,
  canRemove,
  decisionNeedsNote,
  decisionsFor,
  documentAccess,
  fileKindOf,
  reviewTransition,
  safeFileName,
} from "./document-rules";
import { documentSectionsFor, findCategory, projectTypeOf } from "./document-taxonomy";
import { ANONYMOUS_VIEWER, toProjectDocument, type DocumentMeta } from "./document-types";

const investor = { signedIn: true, isOwner: false, isAdmin: false };
const issuer = { signedIn: true, isOwner: true, isAdmin: false };
const admin = { signedIn: true, isOwner: false, isAdmin: true };

test("investors and visitors only ever see released documents", () => {
  for (const status of ["uploading", "pending", "rejected", "withdrawn", "superseded"] as const) {
    assert.deepEqual(documentAccess(investor, status), { list: false, open: false });
    assert.deepEqual(documentAccess(ANONYMOUS_VIEWER, status), { list: false, open: false });
  }
});

test("a released document opens for signed-in investors but not for signed-out visitors", () => {
  assert.deepEqual(documentAccess(investor, "released"), { list: true, open: true });
  assert.deepEqual(documentAccess(ANONYMOUS_VIEWER, "released"), { list: true, open: false });
});

test("the issuer and administrators see every document, including ones under review", () => {
  assert.deepEqual(documentAccess(issuer, "pending"), { list: true, open: true });
  assert.deepEqual(documentAccess(admin, "rejected"), { list: true, open: true });
});

test("issuers can remove drafts and rejected files but never a released document", () => {
  assert.equal(canRemove(issuer, "pending"), true);
  assert.equal(canRemove(issuer, "rejected"), true);
  assert.equal(canRemove(issuer, "released"), false);
  assert.equal(canRemove(issuer, "withdrawn"), false);
  assert.equal(canRemove(admin, "released"), false);
  assert.equal(canRemove(admin, "withdrawn"), true);
  assert.equal(canRemove(investor, "pending"), false);
});

test("only pending documents can be approved for release or rejected", () => {
  assert.deepEqual(reviewTransition("pending", "release"), { ok: true, to: "released" });
  assert.deepEqual(reviewTransition("pending", "reject"), { ok: true, to: "rejected" });
  assert.equal(reviewTransition("rejected", "release").ok, false);
  assert.equal(reviewTransition("uploading", "release").ok, false);
  assert.deepEqual(reviewTransition("released", "withdraw"), { ok: true, to: "withdrawn" });
  assert.deepEqual(reviewTransition("rejected", "reopen"), { ok: true, to: "pending" });
  assert.deepEqual(decisionsFor("pending"), ["release", "reject"]);
  assert.deepEqual(decisionsFor("superseded"), []);
});

test("rejecting or withdrawing needs a reason; releasing does not", () => {
  assert.equal(decisionNeedsNote("reject"), true);
  assert.equal(decisionNeedsNote("withdraw"), true);
  assert.equal(decisionNeedsNote("release"), false);
});

test("file types are decided by extension and a contradicting browser type is refused", () => {
  assert.equal(fileKindOf("Title deed.PDF", "application/pdf"), "pdf");
  assert.equal(fileKindOf("model.xlsx", ""), "xlsx");
  assert.equal(fileKindOf("report.pdf", "text/html"), null);
  assert.equal(fileKindOf("page.html", "text/html"), null);
  assert.equal(fileKindOf("logo.svg", "image/svg+xml"), null);
});

test("file contents must match the claimed type", () => {
  const enc = new TextEncoder();
  assert.equal(bytesMatchKind("pdf", enc.encode("%PDF-1.7 rest")), true);
  assert.equal(bytesMatchKind("pdf", enc.encode("<html>")), false);
  assert.equal(bytesMatchKind("docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0])), true);
  assert.equal(bytesMatchKind("txt", enc.encode("plain notes")), true);
  assert.equal(bytesMatchKind("txt", enc.encode("<!DOCTYPE html><script>")), false);
  assert.equal(bytesMatchKind("csv", new Uint8Array([0x61, 0x00, 0x62])), false);
});

test("download names are made safe", () => {
  assert.equal(safeFileName('../../etc/"passwd".pdf'), "_passwd_.pdf");
  assert.equal(safeFileName("C:\\Users\\me\\Deed.pdf"), "Deed.pdf");
  assert.equal(safeFileName(""), "document");
});

test("project categories map to the right document profile", () => {
  assert.equal(projectTypeOf("Renewables"), "renewables");
  assert.equal(projectTypeOf("Renewable energy"), "renewables");
  assert.equal(projectTypeOf("Real estate"), "real_estate");
  assert.equal(projectTypeOf("Private credit"), "private_credit");
  assert.equal(projectTypeOf("Infrastructure"), "infrastructure");
  assert.equal(projectTypeOf("Art"), "other");
  assert.equal(projectTypeOf(null), "other");
});

test("document types are limited to the project's kind", () => {
  assert.ok(findCategory("renewables", "ppa"));
  assert.equal(findCategory("real_estate", "ppa"), null);
  assert.ok(findCategory("real_estate", "title_deed"));
  assert.equal(findCategory("renewables", "title_deed"), null);
  assert.ok(findCategory("private_credit", "facility_agreement"));
  // Common sections exist for every project type.
  for (const t of [
    "renewables",
    "real_estate",
    "private_credit",
    "infrastructure",
    "other",
  ] as const) {
    assert.ok(findCategory(t, "constitutional"));
    assert.ok(findCategory(t, "financial_statements"));
    const keys = documentSectionsFor(t).flatMap((s) => s.categories.map((c) => c.key));
    assert.equal(new Set(keys).size, keys.length, `duplicate category in ${t}`);
  }
});

test("review notes and history are hidden from investors", () => {
  const meta: DocumentMeta = {
    schema: 1,
    id: "d",
    fundingRequestId: "r",
    sectionKey: "corporate",
    categoryKey: "constitutional",
    title: "Articles",
    description: null,
    fileName: "a.pdf",
    kind: "pdf",
    size: 10,
    sha256: "x",
    version: 1,
    replaces: null,
    status: "released",
    uploadedBy: "user-1",
    uploadedAt: "2026-01-01T00:00:00Z",
    submittedAt: null,
    reviewedAt: null,
    reviewNote: "internal",
    releasedAt: null,
    history: [
      { at: "2026-01-02T00:00:00Z", action: "released", actor: "administrator", note: null },
    ],
  };
  const forInvestor = toProjectDocument(meta, investor)!;
  assert.equal(forInvestor.reviewNote, null);
  assert.equal(forInvestor.history, null);
  assert.equal("uploadedBy" in forInvestor, false);
  assert.equal(toProjectDocument({ ...meta, status: "pending" }, investor), null);
  assert.equal(toProjectDocument(meta, issuer)!.reviewNote, "internal");
});
