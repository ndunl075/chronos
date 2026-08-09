import { logicalSequence, type ReplayItem } from "@chronos/protocol";
import {
  computeReplayContext,
  indexSession,
  prepareBranchPlan,
  SessionIndex,
  type BranchPlanIntent,
  type SessionGraphInput,
} from "../src/index.js";

declare const input: SessionGraphInput;
const index = indexSession(input);
const context = computeReplayContext(
  index,
  index.rootBranchId,
  logicalSequence(1),
);
const plan: BranchPlanIntent = prepareBranchPlan(index, {
  id: "new",
  parentBranchId: index.rootBranchId,
  forkSeq: logicalSequence(1),
  instruction: "continue",
});
const event: ReplayItem | undefined = context[0];
const opaque: SessionIndex = index;
void plan;
void event;
void opaque;

// @ts-expect-error unbranded coordinates cannot cross the core boundary
computeReplayContext(index, index.rootBranchId, 1);
// @ts-expect-error output collections are immutable
context.push(context[0]);
// @ts-expect-error callers cannot construct an unvalidated index
new SessionIndex(Symbol(), input.session, "root", new Map(), new Set(), []);
