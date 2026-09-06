import type { CaseArtifact } from "./case-artifact";

// 明确的隐藏冲突不得作为开局人物标签；语义改写与跨字段拼接另由生成审查处理。
const hiddenConflictPattern =
  /(?:经济|财务|债务|金钱|利益|合同|遗产|股权|感情).{0,8}(?:纠纷|争执|冲突|矛盾)|纠纷|欠款|欠债|讨债|催债|债务|挪用|侵吞|贪污|勒索|敲诈|威胁|报复|灭口|婚外情|出轨|争夺遗产|因.{0,12}(?:争吵|争执|被辞退)|(?:被|遭).{0,8}辞退|(?:索讨|追讨|催收|拖欠|扣发).{0,8}(?:分红|尾款|报酬|货款|工资|款项)/u;

export function containsHiddenConflict(text: string): boolean {
  return hiddenConflictPattern.test(text);
}

/** 历史账本不重写；人物卡隐藏明确的冲突句，知识与证据仍按原有规则解锁。 */
export function publicCharacterProfile(
  character: CaseArtifact["characters"][number],
): string {
  const publicSentences = character.publicProfile
    .split(/(?<=[。！？；])/u)
    .filter((sentence) => !containsHiddenConflict(sentence));
  return publicSentences.join("").trim() || `${character.occupation}。`;
}
