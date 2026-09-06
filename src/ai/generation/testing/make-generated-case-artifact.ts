import { tutorialCase } from "@/content/tutorial/tutorial-case";
import {
  parseCaseArtifact,
  type CaseArtifact,
} from "@/domain/case/case-artifact";

import { deriveGenerationPlan } from "../generation-plan";

/** 可独立发布的生成测试账本，不依赖编译器补写证据关系或清除前置条件。 */
export function makeGeneratedCaseArtifact(
  id: string,
  seed: string,
  title = tutorialCase.title,
): CaseArtifact {
  const draft = structuredClone(tutorialCase);
  const plan = deriveGenerationPlan(seed);
  draft.id = id;
  draft.seed = seed;
  draft.title = title;
  draft.briefing = `暴雨夜，收藏家顾明远在顾宅晚宴结束后被发现倒在二楼书房。房门和窗户没有破坏痕迹。警方封闭现场，${plan.suspectCount}名嫌疑人等待核实当晚行踪。先固定现场物件与时间，再沿记录和证词追查。`;

  const character = (characterId: string) => draft.characters.find((item) => item.id === characterId)!;
  const evidence = (evidenceId: string) => draft.evidence.find((item) => item.id === evidenceId)!;
  draft.scenes[1]!.objects[0]!.description = "茶盘上留下杯底水印，送茶经过需要询问厨房值守人员。";
  draft.scenes[2]!.objects[0]!.description = "终端保存门禁、电梯与监控备份，需要恢复被删除的日志片段。";

  // 首轮勘验留下后续送检、调阅和询问的具体方向；敏感证据保留其原有证明力。
  evidence("evidence_broken_watch").description = "腕表停在九点十分。现场编号已固定：冷茶和黄铜摆件可送检，书桌抽屉和碎纸篓的材料需按编号调阅；厨房值守人员可以核实茶盘经过。";
  evidence("evidence_torn_audit_memo").description = "备忘录列出李闻舟控制账户的异常转账，并写明顾明远将在次日上午提交财务证据。";
  evidence("evidence_smart_lock_log").description = "九点零六分，顾明远遗失的备用门卡打开书房；同一时刻的走廊读头拍到李闻舟持卡进入。";
  for (const evidenceId of [
    "evidence_transfer_ledger",
  ]) {
    evidence(evidenceId).discovery.prerequisiteEvidenceIds = ["evidence_broken_watch"];
  }

  if (plan.suspectCount === 3) {
    draft.characters = draft.characters.filter((item) => item.id !== "character_chen_mo");
    draft.claims = draft.claims.filter((item) => item.speakerId !== "character_chen_mo");
    draft.facts = draft.facts.filter((item) => item.id !== "fact_alibi_chen");
    draft.facts.find((item) => item.id === "fact_sedative_source")!.statement = "顾宅药箱保存着同类镇静剂，取用情况需要进一步核实。";
    const equipmentRecord = evidence("evidence_paint_curing_record");
    equipmentRecord.description = "恒温设备在案发前后运行，日志只记录了工作台编号，无法辨认操作者；沈岚保管着对应工作台的录像，可向她索取核对。";
    equipmentRecord.supportsFactIds = [];
    equipmentRecord.excludesCharacterIds = [];
    equipmentRecord.critical = false;
    draft.claims.find((item) => item.id === "claim_shen_alibi")!.statement = "我在修复室处理油画，设备记录只能核对时间，我还可以提供工作台录像核实。";
    const interview = evidence("evidence_livestream_record");
    interview.name = "沈岚提供的修复工作台录像";
    interview.description = "沈岚交付了20:30至21:35修复室连续原片，画面清楚辨认她本人始终操作工作台且未离开，时间与恒温设备日志吻合。";
    interview.supportsFactIds = ["fact_alibi_shen"];
    interview.excludesCharacterIds = ["character_shen_lan"];
    interview.discovery = {
      method: "interview",
      characterId: "character_shen_lan",
      actionAliases: ["询问沈岚工作台录像"],
      dialogueAliases: ["修复室录像能提供吗", "当时你一直在工作台吗", "设备记录如何核实"],
      dialogueUtterance: "这是我交给你的20:30至21:35修复室连续原片，清楚拍到我本人始终在工作台操作，没有离开；可以和设备操作记录核对。",
      prerequisiteEvidenceIds: ["evidence_broken_watch", "evidence_teacup_residue"],
    };
    character("character_shen_lan").knowledge.evidenceIds.push(interview.id);
  }

  if (plan.supportingCharacterCount === 1) {
    draft.characters = draft.characters.filter((item) => item.id !== "character_han_zhuo");
    draft.claims = draft.claims.filter((item) => item.speakerId !== "character_han_zhuo");
    draft.unlockRules = draft.unlockRules.filter((rule) => rule.targetId !== "character_han_zhuo");
  } else if (plan.minimumWitnessInterviewCharacters === 2) {
    evidence("evidence_elevator_log").discovery = {
      method: "interview",
      sceneId: "scene_security_room",
      characterId: "character_han_zhuo",
      actionAliases: ["询问韩卓货梯记录"],
      dialogueAliases: ["货梯记录显示了什么", "赵衡案发时在哪里", "你能核实货梯行程吗"],
      dialogueUtterance: `我已调出并交付这份记录。${evidence("evidence_elevator_log").description}`,
      prerequisiteEvidenceIds: evidence("evidence_elevator_log").discovery.prerequisiteEvidenceIds,
    };
    const terminal = draft.scenes[2]!.objects[0]!;
    terminal.evidenceIds = terminal.evidenceIds.filter((evidenceId) => evidenceId !== "evidence_elevator_log");
  }

  if (plan.suspectCount === 5) {
    draft.characters.push({
      ...structuredClone(character("character_shen_lan")),
      id: "character_qin_yu",
      name: "秦瑜",
      occupation: "藏品摄影师",
      publicProfile: "受邀在晚宴前为藏品拍照，当晚使用一楼摄影间。",
      privateProfile: "案发时仍在一楼摄影间完成逐帧拍摄，连续原片可以验证。",
      knowledge: { factIds: ["fact_alibi_qin"], evidenceIds: ["evidence_camera_originals"], claimIds: ["claim_qin_alibi"] },
      secretFactIds: [],
      lieRules: [],
    });
    draft.facts.push({ id: "fact_alibi_qin", type: "alibi", statement: "秦瑜在案发时持续操作一楼摄影间的相机，原片及远程快门日志吻合。" });
    draft.claims.push({ id: "claim_qin_alibi", speakerId: "character_qin_yu", kind: "truth", statement: "我在摄影间拍摄，原片保留了拍摄时间，可以调取核对。", factIds: ["fact_alibi_qin"] });
    draft.evidence.push({
      id: "evidence_camera_originals",
      name: "摄影间连续原片",
      description: "连续原片中的玻璃倒影始终显示秦瑜在一楼摄影间，时间与服务器签名的快门日志一致。",
      kind: "digital",
      supportsFactIds: ["fact_alibi_qin"],
      contradictsClaimIds: [],
      implicatesCharacterIds: [],
      excludesCharacterIds: ["character_qin_yu"],
      critical: true,
      discovery: { method: "query", actionAliases: ["调取摄影间原片"], prerequisiteEvidenceIds: ["evidence_broken_watch"] },
    });
    draft.solution.requiredEvidenceIds.push("evidence_camera_originals");
  }

  if (plan.supportingCharacterCount === 3) {
    draft.characters.push({
      ...structuredClone(character("character_luo_fang")),
      id: "character_wu_yue",
      name: "吴悦",
      occupation: "晚宴服务员",
      publicProfile: "当晚负责厨房清点餐具和晚宴收尾。",
      privateProfile: "发现少了一只茶杯，记得管家可以说明茶盘送出的经过。",
      knowledge: { factIds: ["fact_tea_inventory"], evidenceIds: [], claimIds: ["claim_wu_inventory"] },
      secretFactIds: [],
      lieRules: [],
    });
    draft.facts.push({ id: "fact_tea_inventory", type: "context", statement: "厨房清点时缺少一只茶杯，罗芳负责记录当晚茶盘去向。" });
    draft.claims.push({ id: "claim_wu_inventory", speakerId: "character_wu_yue", kind: "truth", statement: "我收尾时发现少一只茶杯，送茶记录由罗芳保管，您可以向她核实。", factIds: ["fact_tea_inventory"] });
  }

  return parseCaseArtifact(draft);
}
