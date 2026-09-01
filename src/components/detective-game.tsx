"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { assignPortraits } from "@/ui/portraits";

type Panel = "briefing" | "scene" | "dialogue" | "notebook" | "report" | "review";

interface CharacterView {
  id: string;
  name: string;
  roleTier: "victim" | "suspect" | "witness" | "referenced";
  occupation: string;
  publicProfile: string;
  portraitTags: {
    gender: "male" | "female" | "nonbinary";
    ageGroup: "child" | "young" | "middle" | "senior";
    temperament: string[];
  };
  presentedEvidenceIds?: string[];
}

interface GameView {
  session: {
    id: string;
    status: "investigating" | "closed";
    revision: number;
    startedAt: string;
    updatedAt: string;
    hintCount: number;
    report?: ReportResult;
  };
  case: {
    id: string;
    title: string;
    briefing: string;
    setting: { era: "contemporary"; place: string; occurredAt: string };
    victim: CharacterView | null;
  };
  characters: CharacterView[];
  scenes: Array<{
    id: string;
    name: string;
    description: string;
    objects: Array<{ id: string; name: string; description: string }>;
  }>;
  evidence: Array<{
    id: string;
    name: string;
    description: string;
    kind: string;
  }>;
  claims: Array<{
    id: string;
    speakerId: string;
    statement: string;
    kind: string;
  }>;
  dialogue: Array<{
    commandId: string;
    at: string;
    characterId: string;
    playerText: string;
    utterance: string;
    demeanor: string;
    disclosedClaimIds: string[];
    discoveredEvidenceIds: string[];
  }>;
  deductions: Array<{
    id: string;
    type: string;
    statement: string;
  }>;
  reportOptions: {
    suspects: CharacterView[];
    motiveFacts: Array<{ id: string; statement: string }>;
    methodFacts: Array<{ id: string; statement: string }>;
    timelineEvents: Array<{ id: string; timestamp: string; description: string }>;
    hasCompleteEvidenceChain: boolean;
  };
}

interface ReportResult {
  verdict: "solved" | "unsolved";
  score: number;
  breakdown: Record<string, number>;
  correct: Record<string, boolean>;
  missedEvidenceIds: string[];
  missedTimelineEventIds: string[];
  feedback?: {
    summary: string;
    strengths: string[];
    gaps: string[];
  };
}

interface LobbyData {
  cases: Array<{
    id: string;
    title: string;
    briefing: string;
    source: "tutorial" | "generated" | "imported";
    createdAt: string;
  }>;
  sessions: Array<{
    id: string;
    caseId: string;
    caseTitle: string;
    status: "investigating" | "closed";
    revision: number;
    updatedAt: string;
    score?: number;
  }>;
  capabilities: { randomGeneration: boolean };
}

interface GenerationJobView {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;
  progress: number;
  result: { caseId?: string; title?: string } | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

interface CaseReview {
  culprit?: CharacterView & { privateProfile?: string };
  motive?: { id: string; statement: string };
  method?: { id: string; statement: string };
  timeline: Array<{ id: string; timestamp: string; description: string }>;
  lies: Array<{ id: string; speakerName: string; statement: string }>;
  evidence: Array<{
    id: string;
    name: string;
    description: string;
    discovered: boolean;
  }>;
  report: ReportResult;
}

interface ReportDraft {
  culpritId: string;
  motiveFactId: string;
  methodFactId: string;
  evidenceIds: string[];
  timelineEventIds: string[];
  reasoning: string;
}

interface PendingDialogue {
  commandId: string;
  characterId: string;
  playerText: string;
}

const emptyReport: ReportDraft = {
  culpritId: "",
  motiveFactId: "",
  methodFactId: "",
  evidenceIds: [],
  timelineEventIds: [],
  reasoning: "",
};

export function DetectiveGame() {
  const [lobby, setLobby] = useState<LobbyData | null>(null);
  const [view, setView] = useState<GameView | null>(null);
  const [review, setReview] = useState<CaseReview | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [panel, setPanel] = useState<Panel>("scene");
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [selectedCharacterId, setSelectedCharacterId] = useState("");
  const [investigationText, setInvestigationText] = useState("");
  const [dialogueText, setDialogueText] = useState("");
  const [pendingDialogue, setPendingDialogue] = useState<PendingDialogue | null>(null);
  const [notes, setNotes] = useState("");
  const [reportDraft, setReportDraft] = useState<ReportDraft>(emptyReport);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [accessRequired, setAccessRequired] = useState(false);
  const [accessPassword, setAccessPassword] = useState("");
  const [godMode, setGodMode] = useState(false);
  const [godSnapshot, setGodSnapshot] = useState<unknown>(null);
  const [generationStatus, setGenerationStatus] = useState("");
  const [generationJob, setGenerationJob] = useState<GenerationJobView | null>(null);
  const [activeGenerationJobId, setActiveGenerationJobId] = useState<string | null>(
    () =>
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem("spy-game-generation-job"),
  );
  const notesSessionRef = useRef("");
  const godPreviousFocusRef = useRef<HTMLElement | null>(null);
  const dialogueRequestRef = useRef(false);
  const activeSessionId = view?.session.id ?? "";
  const activeSessionRevision = view?.session.revision ?? 0;

  const loadLobby = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await requestJson<LobbyData>("/api/bootstrap");
      setLobby(data);
      setAccessRequired(false);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "access_required") {
        setAccessRequired(true);
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    requestJson<LobbyData>("/api/bootstrap")
      .then((data) => {
        if (!active) return;
        setLobby(data);
        setAccessRequired(false);
      })
      .catch((caught) => {
        if (!active) return;
        if (caught instanceof ApiError && caught.code === "access_required") {
          setAccessRequired(true);
        } else {
          setError(errorMessage(caught));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!activeGenerationJobId) return;
    let active = true;
    let polling = false;

    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const result = await requestJson<{ job: GenerationJobView }>(
          `/api/jobs/${activeGenerationJobId}`,
        );
        if (!active) return;

        const job = result.job;
        setGenerationJob(job);
        setGenerationStatus(generationStatusText(job));
        if (job.status === "queued" || job.status === "running") return;

        window.localStorage.removeItem("spy-game-generation-job");
        setActiveGenerationJobId(null);
        if (job.status === "succeeded") {
          await loadLobby();
          return;
        }

        setError(generationFailureMessage(job));
      } catch (caught) {
        if (!active) return;
        if (
          caught instanceof ApiError &&
          (caught.code === "not_found" || caught.code === "forbidden")
        ) {
          window.localStorage.removeItem("spy-game-generation-job");
          setActiveGenerationJobId(null);
          setGenerationJob(null);
          setGenerationStatus("上一次尝试的案件记录已失效。");
          return;
        }
        setGenerationStatus("暂时无法同步案件进度，正在重新连接…");
      } finally {
        polling = false;
      }
    };

    void poll();
    const interval = window.setInterval(() => void poll(), 2_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [activeGenerationJobId, loadLobby]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.shiftKey &&
        event.key.toLowerCase() === "g"
      ) {
        event.preventDefault();
        setGodMode((enabled) => {
          if (!enabled) {
            godPreviousFocusRef.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
          }
          return !enabled;
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!godMode || !activeSessionId) return;
    void requestJson<{ snapshot: unknown }>(
      `/api/games/${activeSessionId}/god`,
    )
      .then((result) => setGodSnapshot(result.snapshot))
      .catch((caught) => setError(errorMessage(caught)));
  }, [activeSessionId, activeSessionRevision, godMode]);

  useEffect(() => {
    if (!godMode) return;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("[data-god-close]")?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      godPreviousFocusRef.current?.focus();
      godPreviousFocusRef.current = null;
    };
  }, [godMode]);

  useEffect(() => {
    if (
      !activeSessionId ||
      notesSessionRef.current !== activeSessionId ||
      view?.session.status === "closed"
    ) {
      return;
    }
    window.localStorage.setItem(`spy-game-notes:${activeSessionId}`, notes);
  }, [activeSessionId, notes, view?.session.status]);

  const portraits = useMemo(() => {
    if (!view) return {};
    const cast = [
      ...(view.case.victim ? [view.case.victim] : []),
      ...view.characters,
    ];
    return assignPortraits(cast, view.case.id);
  }, [view]);

  const selectedScene =
    view?.scenes.find((scene) => scene.id === selectedSceneId) ?? view?.scenes[0];
  const selectedCharacter = view?.characters.find(
    (character) => character.id === selectedCharacterId,
  ) ?? view?.characters[0];
  const dialogueHistory = view?.dialogue.filter(
    (exchange) => exchange.characterId === selectedCharacterId,
  );
  const pendingDialogueForSelectedCharacter =
    pendingDialogue?.characterId === selectedCharacterId ? pendingDialogue : null;

  async function unlockAccess(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await requestJson("/api/access", {
        method: "POST",
        body: JSON.stringify({ password: accessPassword }),
      });
      setAccessPassword("");
      await loadLobby();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function loadReview(sessionId: string) {
    setReviewError("");
    try {
      const result = await requestJson<{ review: CaseReview | null }>(
        `/api/games/${sessionId}/review`,
      );
      setReview(result.review);
    } catch (caught) {
      const message = errorMessage(caught);
      setReviewError(message);
      setError(message);
    }
  }

  function enterGame(nextView: GameView) {
    window.scrollTo(0, 0);
    setView(nextView);
    setSelectedSceneId(nextView.scenes[0]?.id ?? "");
    setSelectedCharacterId(nextView.characters[0]?.id ?? "");
    const notesKey = `spy-game-notes:${nextView.session.id}`;
    notesSessionRef.current = nextView.session.id;
    setNotes(window.localStorage.getItem(notesKey) ?? "");
    setReportDraft(emptyReport);
    setPendingDialogue(null);
    dialogueRequestRef.current = false;
    setReview(null);
    setReviewError("");
    if (nextView.session.status === "closed") {
      setPanel("review");
      void loadReview(nextView.session.id);
    }
  }

  function switchPanel(nextPanel: Panel) {
    setPanel(nextPanel);
    window.scrollTo(0, 0);
  }

  async function startCase(caseId: string) {
    await runBusy(async () => {
      const result = await requestJson<{ view: GameView }>("/api/games", {
        method: "POST",
        body: JSON.stringify({ caseId }),
      });
      enterGame(result.view);
      setPanel("briefing");
      setNotice("案件卷宗已启封，请先阅读开案背景");
    });
  }

  async function resumeGame(sessionId: string) {
    await runBusy(async () => {
      const result = await requestJson<{ view: GameView }>(
        `/api/games/${sessionId}`,
      );
      enterGame(result.view);
      setPanel(result.view.session.status === "closed" ? "review" : "scene");
    });
  }

  async function investigate(objectId?: string, objectName?: string) {
    if (!view) return;
    const text = objectName ? `仔细检查${objectName}` : investigationText.trim();
    if (!text) return;
    await runBusy(async () => {
      const result = await requestJson<{
        outcome: {
          status: string;
          discoveredEvidenceIds: string[];
          unlockedSceneIds: string[];
          unlockedCharacterIds: string[];
        };
        view: GameView;
      }>(`/api/games/${view.session.id}/actions`, {
        method: "POST",
        body: JSON.stringify({
          type: "investigate",
          commandId: commandId(),
          expectedRevision: view.session.revision,
          text,
          sceneId: objectId ? selectedSceneId || undefined : undefined,
          objectId,
        }),
      });
      setView(result.view);
      setInvestigationText("");
      setNotice(investigationNotice(result.outcome));
    });
  }

  async function talk() {
    if (
      !view ||
      !selectedCharacter ||
      !dialogueText.trim() ||
      dialogueRequestRef.current
    ) {
      return;
    }
    const playerText = dialogueText.trim();
    const currentCommandId = commandId();
    const characterId = selectedCharacter.id;
    let responseReceived = false;

    dialogueRequestRef.current = true;
    // Render the detective's line before the model round trip so a slow reply never looks frozen.
    setDialogueText("");
    setPendingDialogue({
      commandId: currentCommandId,
      characterId,
      playerText,
    });
    await runBusy(async () => {
      const result = await requestJson<{
        outcome: {
          status: string;
          response?: { utterance: string; demeanor: string };
          discoveredEvidenceIds: string[];
        };
        view: GameView;
      }>(`/api/games/${view.session.id}/dialogue`, {
        method: "POST",
        body: JSON.stringify({
          commandId: currentCommandId,
          expectedRevision: view.session.revision,
          characterId,
          text: playerText,
        }),
      });
      responseReceived = true;
      setView(result.view);
      setNotice(
        result.outcome.discoveredEvidenceIds.length > 0
          ? `证言已记录，新线索 ${result.outcome.discoveredEvidenceIds.length} 条`
          : "本轮询问已记录",
      );
    });
    dialogueRequestRef.current = false;
    setPendingDialogue((current) =>
      current?.commandId === currentCommandId ? null : current,
    );
    if (!responseReceived) setDialogueText(playerText);
  }

  async function useHint() {
    if (!view) return;
    await runBusy(async () => {
      const result = await requestJson<{
        outcome: { status: string; hint?: string };
        view: GameView;
      }>(`/api/games/${view.session.id}/actions`, {
        method: "POST",
        body: JSON.stringify({
          type: "hint",
          commandId: commandId(),
          expectedRevision: view.session.revision,
        }),
      });
      setView(result.view);
      setNotice(result.outcome.hint ?? "没有更多提示");
    });
  }

  async function showEvidence(evidenceId: string) {
    if (!view || !selectedCharacter) return;
    await runBusy(async () => {
      const result = await requestJson<{
        outcome: { status: string };
        view: GameView;
      }>(`/api/games/${view.session.id}/actions`, {
        method: "POST",
        body: JSON.stringify({
          type: "present_evidence",
          commandId: commandId(),
          expectedRevision: view.session.revision,
          characterId: selectedCharacter.id,
          evidenceId,
        }),
      });
      setView(result.view);
      setNotice(
        result.outcome.status === "presented" ? "证据已出示" : "这份证据无法出示",
      );
    });
  }

  async function submitReport(event: React.FormEvent) {
    event.preventDefault();
    if (!view || !reportIsComplete(reportDraft)) return;
    await runBusy(async () => {
      const result = await requestJson<{
        view: GameView;
        review: CaseReview;
      }>(`/api/games/${view.session.id}/actions`, {
        method: "POST",
        body: JSON.stringify({
          type: "submit_report",
          commandId: commandId(),
          expectedRevision: view.session.revision,
          ...reportDraft,
        }),
      });
      setView(result.view);
      setReview(result.review);
      setReviewError("");
      switchPanel("review");
    });
  }

  async function generateCase(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await runBusy(async () => {
      const queued = await requestJson<{ jobId: string; seed: string }>(
        "/api/generation",
        {
          method: "POST",
          body: JSON.stringify({
            theme: String(form.get("theme") ?? "现代都市密室"),
            locationHint: String(form.get("locationHint") ?? "") || undefined,
            difficulty: String(form.get("difficulty") ?? "standard"),
          }),
        },
      );
      const queuedAt = new Date().toISOString();
      setGenerationJob({
        id: queued.jobId,
        status: "queued",
        stage: "queued",
        progress: 0,
        result: null,
        error: null,
        attempts: 0,
        maxAttempts: 3,
        createdAt: queuedAt,
        updatedAt: queuedAt,
      });
      window.localStorage.setItem("spy-game-generation-job", queued.jobId);
      setActiveGenerationJobId(queued.jobId);
      setGenerationStatus("正在为这起新案件建立档案…");
    });
  }

  async function importCase(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (file.size > 2_000_000) {
      setError("案件文件不能超过 2 MB。");
      return;
    }
    await runBusy(async () => {
      const bundle = JSON.parse(await file.text()) as unknown;
      const result = await requestJson<{ case: { title: string } }>(
        "/api/cases/import",
        {
          method: "POST",
          body: JSON.stringify(bundle),
        },
      );
      await loadLobby();
      setNotice(`《${result.case.title}》已通过校验并归档`);
    });
  }

  async function runBusy(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingScreen />;
  if (accessRequired) {
    return (
      <AccessGate
        password={accessPassword}
        busy={busy}
        error={error}
        onPasswordChange={setAccessPassword}
        onSubmit={unlockAccess}
      />
    );
  }
  if (!view) {
    const generationBusy =
      generationJob?.status === "queued" || generationJob?.status === "running";
    return (
      <Lobby
        data={lobby}
        busy={busy || generationBusy}
        error={error}
        generationStatus={generationStatus}
        generationJob={generationJob}
        onStart={startCase}
        onResume={resumeGame}
        onGenerate={generateCase}
        onImport={importCase}
        onRetry={loadLobby}
      />
    );
  }
  const closed = view.session.status === "closed";

  return (
    <main className="workbench">
      <header className="case-header">
        <button
          className="brand-mark"
          onClick={() => {
            window.scrollTo(0, 0);
            setView(null);
            setReview(null);
            void loadLobby();
          }}
          aria-label="返回案件大厅"
        >
          <span>CASE</span>
          <strong>{"//FILE"}</strong>
        </button>
        <div className="case-heading">
          <p className="eyebrow">{view.case.setting.place}</p>
          <h1>{view.case.title}</h1>
        </div>
        <div className="case-status" aria-label="调查进度">
          <span>{view.evidence.length} 条线索</span>
          <span>{view.session.hintCount} 次提示</span>
          <span>R{view.session.revision.toString().padStart(2, "0")}</span>
        </div>
      </header>

      <nav className="mode-strip" aria-label="工作台模式">
        <ModeButton active={panel === "briefing"} onClick={() => switchPanel("briefing")}>
          案件背景
        </ModeButton>
        <ModeButton active={panel === "scene"} onClick={() => switchPanel("scene")}>
          现场搜证
        </ModeButton>
        <ModeButton
          active={panel === "dialogue"}
          onClick={() => switchPanel("dialogue")}
        >
          人物询问
        </ModeButton>
        <ModeButton
          active={panel === "notebook"}
          onClick={() => switchPanel("notebook")}
        >
          线索簿
        </ModeButton>
        <ModeButton
          active={panel === "report" || panel === "review"}
          onClick={() => switchPanel(closed ? "review" : "report")}
        >
          {closed ? "结案复盘" : "提交结论"}
        </ModeButton>
      </nav>

      <section className="workbench-grid">
        <aside className="case-rail">
          <div className="rail-section victim-card">
            <span className="section-index">00 / VICTIM</span>
            {view.case.victim && (
              <CharacterPortrait
                character={view.case.victim}
                src={portraits[view.case.victim.id]}
                compact
              />
            )}
          </div>
          <div className="rail-section cast-list">
            <div className="section-title-row">
              <span className="section-index">01 / PERSONS</span>
              <span>{view.characters.length}</span>
            </div>
            {view.characters.map((character) => (
              <button
                key={character.id}
                className={`cast-row ${selectedCharacterId === character.id ? "is-active" : ""}`}
                onClick={() => {
                  setSelectedCharacterId(character.id);
                  switchPanel("dialogue");
                }}
              >
                <Image
                  src={portraits[character.id]}
                  alt=""
                  width={52}
                  height={72}
                />
                <span>
                  <strong>{character.name}</strong>
                  <small>{character.occupation}</small>
                </span>
                <i>{character.roleTier === "suspect" ? "嫌" : "证"}</i>
              </button>
            ))}
          </div>
        </aside>

        <section className="primary-stage">
          {panel === "briefing" && (
            <BriefingPanel
              caseInfo={view.case}
              onBegin={() => switchPanel("scene")}
            />
          )}
          {panel === "scene" && selectedScene && (
            <ScenePanel
              scene={selectedScene}
              scenes={view.scenes}
              selectedSceneId={selectedSceneId}
              investigationText={investigationText}
              busy={busy || closed}
              onSceneChange={setSelectedSceneId}
              onTextChange={setInvestigationText}
              onInvestigate={investigate}
            />
          )}
          {panel === "dialogue" && selectedCharacter && (
            <DialoguePanel
              character={selectedCharacter}
              characters={view.characters}
              selectedCharacterId={selectedCharacter.id}
              portrait={portraits[selectedCharacter.id]}
              history={dialogueHistory ?? []}
              pendingDialogue={pendingDialogueForSelectedCharacter}
              evidence={view.evidence}
              text={dialogueText}
              busy={busy || closed}
              onTextChange={setDialogueText}
              onCharacterChange={setSelectedCharacterId}
              onTalk={talk}
              onShowEvidence={showEvidence}
            />
          )}
          {panel === "notebook" && (
            <NotebookPanel
              view={view}
              notes={notes}
              readOnly={closed}
              onNotesChange={setNotes}
            />
          )}
          {panel === "report" && (
            <ReportPanel
              view={view}
              draft={reportDraft}
              busy={busy || closed}
              onChange={setReportDraft}
              onSubmit={submitReport}
            />
          )}
          {panel === "review" && (
            <ReviewPanel
              review={review}
              error={reviewError}
              onRetry={() => void loadReview(view.session.id)}
            />
          )}
        </section>

        <aside className="evidence-rail">
          <div className="section-title-row">
            <span className="section-index">02 / DISCOVERED</span>
            <span>{view.evidence.length}</span>
          </div>
          <div className="evidence-stack">
            {view.evidence.length === 0 ? (
              <p className="empty-copy">现场仍是一张白纸。选择场景，描述你想检查的地方。</p>
            ) : (
              view.evidence.map((evidence, index) => (
                <article className="evidence-slip" key={evidence.id}>
                  <span>E-{String(index + 1).padStart(2, "0")}</span>
                  <h3>{evidence.name}</h3>
                  <p>{evidence.description}</p>
                </article>
              ))
            )}
          </div>
          <button
            className="hint-button"
            onClick={useHint}
            disabled={busy || closed}
          >
            {closed ? "案件已结案" : "请求提示"}{" "}
            <span>{closed ? "READ ONLY" : "−2 分 / 级"}</span>
          </button>
        </aside>
      </section>

      {(notice || error) && (
        <div
          className={`toast ${error ? "is-error" : ""}`}
          role={error ? "alert" : "status"}
        >
          {error || notice}
          <button
            aria-label="关闭通知"
            title="关闭通知"
            onClick={() => (error ? setError("") : setNotice(""))}
          >
            ×
          </button>
        </div>
      )}
      {busy && (
        <div className="busy-line" role="status" aria-live="polite">
          <span className="visually-hidden">处理中</span>
        </div>
      )}
      {godMode && (
        <GodModePanel snapshot={godSnapshot} onClose={() => setGodMode(false)} />
      )}
    </main>
  );
}

function LoadingScreen() {
  return (
    <main className="loading-screen" aria-busy="true">
      <div className="archive-loader" role="status" aria-label="正在调取卷宗">
        <span />
        <span />
        <span />
      </div>
      <p>正在调取卷宗</p>
    </main>
  );
}

function AccessGate(props: {
  password: string;
  busy: boolean;
  error: string;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <main className="access-gate texture-noise">
      <section className="access-card">
        <p className="eyebrow">RESTRICTED ARCHIVE · 侦查档案室</p>
        <h1>此卷宗需要访问口令</h1>
        <p>输入部署者设置的共享口令。通过后，本设备会保留匿名游戏进度。</p>
        <form onSubmit={props.onSubmit}>
          <label htmlFor="access-password">访问口令</label>
          <input
            id="access-password"
            type="password"
            value={props.password}
            onChange={(event) => props.onPasswordChange(event.target.value)}
            autoFocus
          />
          <button className="primary-button" disabled={props.busy}>
            {props.busy ? "核验中…" : "进入档案室"}
          </button>
        </form>
        {props.error && <p className="form-error" role="alert">{props.error}</p>}
      </section>
    </main>
  );
}

function Lobby(props: {
  data: LobbyData | null;
  busy: boolean;
  error: string;
  generationStatus: string;
  generationJob: GenerationJobView | null;
  onStart: (caseId: string) => void;
  onResume: (sessionId: string) => void;
  onGenerate: (event: React.FormEvent<HTMLFormElement>) => void;
  onImport: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onRetry: () => void;
}) {
  const sessions = props.data?.sessions ?? [];
  const hasContinuingSessions = sessions.length > 0;
  const generatorSectionNumber = hasContinuingSessions ? 3 : 2;

  return (
    <main className="lobby texture-noise">
      <header className="lobby-header">
        <div className="brand-lockup">
          <span>{"CASE//FILE"}</span>
          <p>多人格智能体推理实验</p>
        </div>
        <div className="archive-number">ARCHIVE 2026—∞</div>
      </header>
      <section className="lobby-hero">
        <p className="eyebrow">你所听见的，未必都是真的</p>
        <h1><span>疑案</span><span>档案</span></h1>
        <p className="hero-copy">
          进入现场，检查物件，向每一个有秘密的人发问。真相不会改变，人的说法会。
        </p>
      </section>

      {props.error && (
        <div className="lobby-error" role="alert">
          <span>{props.error}</span>
          <button onClick={props.onRetry}>重试</button>
        </div>
      )}

      <section className="archive-section">
        <div className="archive-section-heading">
          <span>01</span>
          <div>
            <p>AVAILABLE FILES</p>
            <h2>选择案件</h2>
          </div>
        </div>
        <div className="case-grid">
          {props.data?.cases.map((caseItem, index) => (
            <article className="case-card" key={caseItem.id}>
              <div className="case-card-topline">
                <span>{caseItem.source === "tutorial" ? "教程卷宗" : "生成卷宗"}</span>
                <span>0{index + 1}</span>
              </div>
              <h3>{caseItem.title}</h3>
              <p>{caseItem.briefing}</p>
              <button onClick={() => props.onStart(caseItem.id)} disabled={props.busy}>
                启封调查 <span>↗</span>
              </button>
            </article>
          ))}
        </div>
      </section>

      {hasContinuingSessions && (
        <section className="archive-section compact-section">
          <div className="archive-section-heading">
            <span>02</span>
            <div>
              <p>ACTIVE RECORDS</p>
              <h2>继续调查</h2>
            </div>
          </div>
          <div className="session-list">
            {sessions.map((session) => (
              <button key={session.id} onClick={() => props.onResume(session.id)}>
                <span className={`status-dot ${session.status}`} />
                <strong>{session.caseTitle}</strong>
                <span>{session.status === "closed" ? `${session.score ?? 0} 分` : `调查 R${session.revision}`}</span>
                <time>{formatDate(session.updatedAt)}</time>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="archive-section generator-section">
        <div className="archive-section-heading">
          <span>{formatSectionNumber(generatorSectionNumber)}</span>
          <div>
            <p>PROCEDURAL CASE</p>
            <h2>生成新案件</h2>
          </div>
        </div>
        <form className="generator-form" onSubmit={props.onGenerate}>
          <label>
            案件主题
            <input name="theme" defaultValue="现代城市中的封闭空间谋杀案" />
          </label>
          <label>
            地点偏好
            <input name="locationHint" placeholder="例如：美术馆、山间酒店" />
          </label>
          <label>
            难度
            <select name="difficulty" defaultValue="standard">
              <option value="easy">轻松</option>
              <option value="standard">标准</option>
              <option value="hard">困难</option>
            </select>
          </label>
          <button
            className="primary-button"
            disabled={props.busy || !props.data?.capabilities.randomGeneration}
          >
            {props.data?.capabilities.randomGeneration ? "生成案件" : "需要 DeepSeek API Key"}
          </button>
        </form>
        <p className="cost-note">
          典型单局估算：低峰约 ¥1.19，高峰约 ¥2.38；实际按生成修复次数与对话长度变化。
        </p>
        {props.generationStatus && (
          <p className="generation-status" role="status">
            {props.generationStatus}
          </p>
        )}
        {props.generationJob && (
          <GenerationProgress job={props.generationJob} />
        )}
        <label className="import-case">
          导入 {"CASE//FILE"} 案件包
          <input
            type="file"
            accept="application/json,.json"
            disabled={props.busy}
            onChange={props.onImport}
          />
        </label>
      </section>
    </main>
  );
}

function GenerationProgress(props: { job: GenerationJobView }) {
  return <GenerationProgressMotion key={props.job.id} job={props.job} />;
}

function GenerationProgressMotion(props: { job: GenerationJobView }) {
  const terminal = isGenerationTerminal(props.job);
  const actualProgress = generationActualProgress(props.job);
  const [displayProgress, setDisplayProgress] = useState(() => actualProgress);

  useEffect(() => {
    if (terminal && props.job.status !== "succeeded") return;
    // The server still owns completion. This only eases sparse backend stage updates
    // into a continuous, never-100%-until-verified player-facing progress signal.
    const advanceProgress = () => {
      setDisplayProgress((current) => {
        const target = terminal
          ? 100
          : generationDisplayTarget(
              props.job.status,
              props.job.stage,
              actualProgress,
            );
        if (current >= target) return current;
        const remaining = target - current;
        return Math.min(
          target,
          current + Math.max(terminal ? 0.9 : 0.18, remaining * (terminal ? 0.22 : 0.075)),
        );
      });
    };

    const interval = window.setInterval(advanceProgress, terminal ? 140 : 600);
    return () => window.clearInterval(interval);
  }, [actualProgress, props.job.id, props.job.stage, props.job.status, terminal]);

  const visibleProgress =
    terminal && props.job.status !== "succeeded"
      ? Math.max(displayProgress, actualProgress)
      : displayProgress;
  const progress = Math.round(visibleProgress);
  return (
    <section
      className={`generation-progress is-${props.job.status} stage-${props.job.stage}`}
      role={props.job.status === "failed" ? "alert" : "status"}
      aria-live="polite"
    >
      <div className="generation-progress-heading">
        <span>{generationStageLabel(props.job)}</span>
        <strong>{progress}%</strong>
      </div>
      <div
        className="generation-progress-track"
        role="progressbar"
        aria-label="案件生成进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        aria-valuetext={`${generationStageLabel(props.job)}，${progress}%`}
      >
        <span style={{ width: `${visibleProgress}%` }} />
      </div>
      <p>
        {terminal
          ? generationTerminalText(props.job)
          : generationProgressText(props.job)}
      </p>
    </section>
  );
}

function BriefingPanel(props: {
  caseInfo: GameView["case"];
  onBegin: () => void;
}) {
  const victim = props.caseInfo.victim;
  return (
    <div className="stage-panel case-briefing-panel">
      <div className="briefing-document">
        <p className="stage-kicker">CASE OPENING / BACKGROUND</p>
        <div className="briefing-heading">
          <span>开案卷宗</span>
          <span>档案已启封</span>
        </div>
        <h2>{props.caseInfo.title}</h2>
        <dl className="briefing-meta">
          <div>
            <dt>案发地点</dt>
            <dd>{props.caseInfo.setting.place}</dd>
          </div>
          <div>
            <dt>记录时间</dt>
            <dd>{formatDate(props.caseInfo.setting.occurredAt)}</dd>
          </div>
          {victim && (
            <div>
              <dt>案件相关者</dt>
              <dd>{victim.name} · {victim.occupation}</dd>
            </div>
          )}
        </dl>
        <section className="briefing-narrative">
          <span>BACKGROUND STORY</span>
          <p>{props.caseInfo.briefing}</p>
        </section>
        <div className="briefing-footer">
          <p>先记住你所知道的。进入现场后，每一条证词都可能改写你的判断。</p>
          <button className="open-case-button" onClick={props.onBegin}>
            进入现场 <span>↘</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ScenePanel(props: {
  scene: GameView["scenes"][number];
  scenes: GameView["scenes"];
  selectedSceneId: string;
  investigationText: string;
  busy: boolean;
  onSceneChange: (id: string) => void;
  onTextChange: (text: string) => void;
  onInvestigate: (objectId?: string, objectName?: string) => void;
}) {
  return (
    <div className="stage-panel scene-panel">
      <div className="stage-kicker">SCENE / ACTIVE SEARCH</div>
      <div className="stage-title-row">
        <div>
          <h2>{props.scene.name}</h2>
          <p>{props.scene.description}</p>
        </div>
        <select
          aria-label="切换场景"
          value={props.selectedSceneId}
          onChange={(event) => props.onSceneChange(event.target.value)}
        >
          {props.scenes.map((scene) => (
            <option key={scene.id} value={scene.id}>{scene.name}</option>
          ))}
        </select>
      </div>
      <section className="scene-guidance" aria-label="现场勘查提示">
        <div>
          <span>现场勘查记录</span>
          <strong>当前可检查 {props.scene.objects.length} 处</strong>
        </div>
        <p>
          先记录物件位置、可见异常和人员动线，再围绕时间、接触痕迹与物品来源逐一核对。
        </p>
        <ul>
          <li>点击物件可执行基础勘查；自由输入可以描述更具体的取证动作。</li>
          <li>发现矛盾后，带着人物、物件或时间去询问；部分关键证词只能通过对话获得。</li>
        </ul>
      </section>
      <div className="object-grid">
        {props.scene.objects.map((object, index) => (
          <button
            key={object.id}
            className="object-card"
            onClick={() => props.onInvestigate(object.id, object.name)}
            disabled={props.busy}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            <h3>{object.name}</h3>
            <p>{object.description}</p>
            <i>检查 ↗</i>
          </button>
        ))}
      </div>
      <form
        className="action-composer"
        onSubmit={(event) => {
          event.preventDefault();
          props.onInvestigate();
        }}
      >
        <label htmlFor="investigation-text">自由描述你的搜查行动</label>
        <div>
          <textarea
            id="investigation-text"
            disabled={props.busy}
            value={props.investigationText}
            onChange={(event) => props.onTextChange(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                event.shiftKey ||
                event.nativeEvent.isComposing
              ) {
                return;
              }
              event.preventDefault();
              if (!props.busy && props.investigationText.trim()) props.onInvestigate();
            }}
            placeholder="例如：我想检查书桌抽屉里有没有被藏起来的文件……（Enter 执行，Shift + Enter 换行）"
            rows={3}
          />
          <button disabled={props.busy || !props.investigationText.trim()}>
            执行搜查
          </button>
        </div>
      </form>
    </div>
  );
}

function DialoguePanel(props: {
  character: CharacterView;
  characters: CharacterView[];
  selectedCharacterId: string;
  portrait: string;
  history: GameView["dialogue"];
  pendingDialogue: PendingDialogue | null;
  evidence: GameView["evidence"];
  text: string;
  busy: boolean;
  onTextChange: (text: string) => void;
  onCharacterChange: (characterId: string) => void;
  onTalk: () => void;
  onShowEvidence: (evidenceId: string) => void;
}) {
  return (
    <div className="stage-panel dialogue-panel">
      <label className="character-switcher">
        询问对象
        <select
          value={props.selectedCharacterId}
          onChange={(event) => props.onCharacterChange(event.target.value)}
        >
          {props.characters.map((character) => (
            <option key={character.id} value={character.id}>
              {character.name} · {character.occupation}
            </option>
          ))}
        </select>
      </label>
      <header className="interview-header">
        <Image src={props.portrait} alt={props.character.name} width={112} height={168} />
        <div>
          <span className="stage-kicker">INTERVIEW / {props.character.roleTier.toUpperCase()}</span>
          <h2>{props.character.name}</h2>
          <p>{props.character.occupation} · {props.character.publicProfile}</p>
          <div className="temperament-list">
            {props.character.portraitTags.temperament.map((tag) => <span key={tag}>{tag}</span>)}
          </div>
        </div>
      </header>
      <p className="interview-guide">
        可从公开身份、现场物件、时间段和矛盾说法切入。部分关键证词需要清楚问到人和事。
      </p>
      <div className="transcript" aria-live="polite">
        {props.history.length === 0 && !props.pendingDialogue ? (
          <div className="transcript-empty">
            <span>REC</span>
            <p>录音尚未开始。你可以自由提问，对方会记住你们的谈话。</p>
          </div>
        ) : (
          props.history.map((exchange) => (
            <div className="exchange" key={exchange.commandId}>
              <p className="detective-line"><span>侦探</span>{exchange.playerText}</p>
              <p className="character-line">
                <span>{props.character.name} · {demeanorLabel(exchange.demeanor)}</span>
                {exchange.utterance}
              </p>
            </div>
          ))
        )}
        {props.pendingDialogue && (
          <div className="exchange is-pending" key={props.pendingDialogue.commandId}>
            <p className="detective-line">
              <span>侦探</span>
              {props.pendingDialogue.playerText}
            </p>
            <p className="character-line response-pending">
              <span>{props.character.name} · 正在回应</span>
              <i>正在整理回答</i>
            </p>
          </div>
        )}
      </div>
      {props.evidence.length > 0 && (
        <details className="present-evidence">
          <summary>向 {props.character.name} 出示证据</summary>
          <div>
            {props.evidence.map((evidence) => (
              <button
                key={evidence.id}
                disabled={
                  props.busy || props.character.presentedEvidenceIds?.includes(evidence.id)
                }
                onClick={() => props.onShowEvidence(evidence.id)}
              >
                {evidence.name}
                <span>{props.character.presentedEvidenceIds?.includes(evidence.id) ? "已出示" : "出示"}</span>
              </button>
            ))}
          </div>
        </details>
      )}
      <form
        className="dialogue-composer"
        onSubmit={(event) => {
          event.preventDefault();
          props.onTalk();
        }}
      >
        <label className="visually-hidden" htmlFor="dialogue-text">
          向{props.character.name}提问
        </label>
        <textarea
          id="dialogue-text"
          disabled={props.busy}
          value={props.text}
          onChange={(event) => props.onTextChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.shiftKey ||
              event.nativeEvent.isComposing
            ) {
              return;
            }
            event.preventDefault();
            if (!props.busy && props.text.trim()) props.onTalk();
          }}
          rows={3}
          placeholder={`向${props.character.name}提问……（Enter 发送，Shift + Enter 换行）`}
        />
        <button disabled={props.busy || !props.text.trim()}>发送询问</button>
      </form>
    </div>
  );
}

function NotebookPanel(props: {
  view: GameView;
  notes: string;
  readOnly: boolean;
  onNotesChange: (notes: string) => void;
}) {
  return (
    <div className="stage-panel notebook-panel">
      <div className="stage-kicker">DETECTIVE NOTEBOOK / AUTO + MANUAL</div>
      <h2>线索与证词</h2>
      <div className="notebook-grid">
        <section>
          <h3>已发现证据 <span>{props.view.evidence.length}</span></h3>
          {props.view.evidence.map((evidence) => (
            <article key={evidence.id}>
              <strong>{evidence.name}</strong>
              <p>{evidence.description}</p>
            </article>
          ))}
        </section>
        <section>
          <h3>人物说法 <span>{props.view.claims.length}</span></h3>
          {props.view.claims.map((claim) => (
            <article key={claim.id}>
              <strong>{characterName(props.view, claim.speakerId)}</strong>
              <p>“{claim.statement}”</p>
            </article>
          ))}
        </section>
        <section>
          <h3>已形成推论 <span>{props.view.deductions.length}</span></h3>
          {props.view.deductions.map((fact) => (
            <article key={fact.id}>
              <strong>{factTypeLabel(fact.type)}</strong>
              <p>{fact.statement}</p>
            </article>
          ))}
        </section>
        <section className="manual-notes">
          <h3>我的笔记 <span>{props.readOnly ? "READ ONLY" : "LOCAL"}</span></h3>
          <label className="visually-hidden" htmlFor="detective-notes">
            我的侦探笔记
          </label>
          <textarea
            id="detective-notes"
            readOnly={props.readOnly}
            value={props.notes}
            onChange={(event) => props.onNotesChange(event.target.value)}
            placeholder="记录你的怀疑、矛盾点和待验证问题。这些内容只保存在当前浏览器。"
          />
        </section>
      </div>
    </div>
  );
}

function ReportPanel(props: {
  view: GameView;
  draft: ReportDraft;
  busy: boolean;
  onChange: (draft: ReportDraft) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const requirements = reportRequirements(props.draft);

  return (
    <form className="stage-panel report-panel" onSubmit={props.onSubmit}>
      <div className="stage-kicker">FINAL REPORT / ONE ATTEMPT</div>
      <h2>提交结案报告</h2>
      <p className="report-warning">
        卷宗提交后不可修改。证据尚未完全闭环时也可以提前锁定真凶；未填写的动机、手法与时间线只会影响最终得分。
      </p>
      <div className="report-fields">
        <label>
          真凶
          <select
            value={props.draft.culpritId}
            onChange={(event) => props.onChange({ ...props.draft, culpritId: event.target.value })}
          >
            <option value="">选择嫌疑人</option>
            {props.view.reportOptions.suspects.map((suspect) => (
              <option key={suspect.id} value={suspect.id}>{suspect.name}</option>
            ))}
          </select>
        </label>
        <label>
          动机判断（可选）
          <select
            value={props.draft.motiveFactId}
            onChange={(event) => props.onChange({ ...props.draft, motiveFactId: event.target.value })}
          >
            <option value="">暂不判断（不影响提交）</option>
            {props.view.reportOptions.motiveFacts.map((fact) => (
              <option key={fact.id} value={fact.id}>{fact.statement}</option>
            ))}
          </select>
        </label>
        <label>
          作案手法（可选）
          <select
            value={props.draft.methodFactId}
            onChange={(event) => props.onChange({ ...props.draft, methodFactId: event.target.value })}
          >
            <option value="">暂不判断（不影响提交）</option>
            {props.view.reportOptions.methodFacts.map((fact) => (
              <option key={fact.id} value={fact.id}>{fact.statement}</option>
            ))}
          </select>
        </label>
      </div>
      <fieldset>
        <legend>证据链</legend>
        <p className="report-choice-note">
          这里只列出你已经获得的线索；至少勾选两条才能提交。勾选表示写入本次报告，并不代表线索尚未发现。
        </p>
        <div className="checkbox-grid">
          {props.view.evidence.map((evidence) => (
            <label key={evidence.id}>
              <input
                type="checkbox"
                checked={props.draft.evidenceIds.includes(evidence.id)}
                onChange={() => props.onChange({
                  ...props.draft,
                  evidenceIds: toggleValue(props.draft.evidenceIds, evidence.id),
                })}
              />
              <span>{evidence.name}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>时间线</legend>
        {!props.view.reportOptions.hasCompleteEvidenceChain ? (
          <p className="locked-copy">必要证据尚未集齐，完整时间线暂无法重建；你仍可提前结案，但时间线项目不会计分。</p>
        ) : (
          <div className="timeline-checks">
            {props.view.reportOptions.timelineEvents.map((event) => (
              <label key={event.id}>
                <input
                  type="checkbox"
                  checked={props.draft.timelineEventIds.includes(event.id)}
                  onChange={() => props.onChange({
                    ...props.draft,
                    timelineEventIds: toggleValue(
                      props.draft.timelineEventIds,
                      event.id,
                    ),
                  })}
                />
                <time>{formatTime(event.timestamp)}</time>
                <span>{event.description}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <label className="reasoning-field">
        推理陈述
        <textarea
          rows={6}
          value={props.draft.reasoning}
          onChange={(event) => props.onChange({ ...props.draft, reasoning: event.target.value })}
          placeholder="至少用 10 个字说明你为什么锁定此人；动机、手法与时间线可在证据完整时补充。"
        />
      </label>
      <button
        className="submit-report"
        disabled={props.busy || requirements.length > 0}
      >
        封存并提交（唯一机会）
      </button>
      {requirements.length > 0 && (
        <p className="report-requirements" aria-live="polite">
          <strong>还不能提交：</strong>{requirements.join("；")}
        </p>
      )}
    </form>
  );
}

function ReviewPanel(props: {
  review: CaseReview | null;
  error: string;
  onRetry: () => void;
}) {
  if (props.error) {
    return (
      <div className="stage-panel review-load-state" role="alert">
        <p>结案复盘读取失败：{props.error}</p>
        <button onClick={props.onRetry}>重新读取</button>
      </div>
    );
  }
  if (!props.review) {
    return (
      <div className="stage-panel review-load-state" role="status">
        <p>正在整理结案复盘…</p>
      </div>
    );
  }
  const review = props.review;
  const completeDossier = reportHasCompleteDossier(review.report);
  return (
    <div className="stage-panel review-panel">
      <div className="verdict-stamp">
        {review.report.verdict === "solved"
          ? completeDossier
            ? "CASE SOLVED"
            : "CASE SOLVED / EARLY"
          : "CASE CLOSED"}
      </div>
      <div className="score-block">
        <span>最终评分</span>
        <strong>{review.report.score}</strong>
        <small>/ 100</small>
      </div>
      <p className="review-closure-copy">
        {review.report.verdict === "solved"
          ? completeDossier
            ? "完整卷宗已封存。"
            : "提前结案成功：已锁定真凶，未完成的卷宗项目未计入得分。"
          : "本次指认未命中真凶，案件已按一次性结案规则封存。"}
      </p>
      <section className="truth-summary">
        <div>
          <span>真凶</span>
          <h2>{review.culprit?.name ?? "未知"}</h2>
          <p>{review.culprit?.privateProfile}</p>
        </div>
        <div>
          <span>动机</span>
          <p>{review.motive?.statement}</p>
          <span>手法</span>
          <p>{review.method?.statement}</p>
        </div>
      </section>
      {review.report.feedback && (
        <section className="report-feedback">
          <span>AI REVIEW / 不参与评分</span>
          <h3>侦探报告复盘</h3>
          <p>{review.report.feedback.summary}</p>
          <div>
            <ul>
              {review.report.feedback.strengths.map((item) => (
                <li key={item}>＋ {item}</li>
              ))}
            </ul>
            <ul>
              {review.report.feedback.gaps.map((item) => (
                <li key={item}>△ {item}</li>
              ))}
            </ul>
          </div>
        </section>
      )}
      <section className="review-timeline">
        <h3>真相时间线</h3>
        {review.timeline.map((event) => (
          <article key={event.id}>
            <time>{formatTime(event.timestamp)}</time>
            <p>{event.description}</p>
          </article>
        ))}
      </section>
      <section className="review-lies">
        <h3>谎言与隐瞒</h3>
        {review.lies.map((lie) => (
          <blockquote key={lie.id}>
            “{lie.statement}” <cite>— {lie.speakerName}</cite>
          </blockquote>
        ))}
      </section>
    </div>
  );
}

function CharacterPortrait(props: {
  character: CharacterView;
  src: string;
  compact?: boolean;
}) {
  return (
    <div className={`character-portrait ${props.compact ? "is-compact" : ""}`}>
      <Image src={props.src} alt={props.character.name} width={209} height={313} />
      <div>
        <strong>{props.character.name}</strong>
        <span>{props.character.occupation}</span>
      </div>
    </div>
  );
}

function ModeButton(props: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={props.active ? "is-active" : ""}
      aria-pressed={props.active}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function GodModePanel(props: { snapshot: unknown; onClose: () => void }) {
  function onKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <aside
      className="god-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="god-mode-title"
      onKeyDown={onKeyDown}
    >
      <header>
        <div>
          <span>GOD MODE</span>
          <strong id="god-mode-title">真相与 Agent 审计</strong>
        </div>
        <div>
          <button onClick={() => exportCaseBundle(props.snapshot)}>导出案件</button>
          <button data-god-close onClick={props.onClose}>关闭</button>
        </div>
      </header>
      <pre>{props.snapshot ? JSON.stringify(props.snapshot, null, 2) : "正在读取审计快照…"}</pre>
    </aside>
  );
}

function exportCaseBundle(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object" || !("truthLedger" in snapshot)) {
    return;
  }
  const truthLedger = snapshot.truthLedger;
  const id =
    truthLedger &&
    typeof truthLedger === "object" &&
    "id" in truthLedger &&
    typeof truthLedger.id === "string"
      ? truthLedger.id
      : "case";
  const blob = new Blob(
    [
      JSON.stringify(
        {
          format: "spy-game-case",
          version: 1,
          exportedAt: new Date().toISOString(),
          caseArtifact: truthLedger,
        },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${id}.case.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function requestJson<T = Record<string, unknown>>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const payload = (await response.json()) as {
    error?: { code?: string; message?: string };
  } & T;
  if (!response.ok) {
    throw new ApiError(
      payload.error?.code ?? "request_failed",
      payload.error?.message ?? "请求失败",
      response.status,
    );
  }
  return payload;
}

function commandId() {
  return `command_${crypto.randomUUID().replaceAll("-", "")}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function investigationNotice(outcome: {
  status: string;
  discoveredEvidenceIds: string[];
  unlockedSceneIds: string[];
  unlockedCharacterIds: string[];
}) {
  if (outcome.status === "discovered") {
    const unlockCount =
      outcome.unlockedSceneIds.length + outcome.unlockedCharacterIds.length;
    return `发现 ${outcome.discoveredEvidenceIds.length} 条新线索${unlockCount ? `，解锁 ${unlockCount} 项调查内容` : ""}`;
  }
  if (outcome.status === "already_discovered") return "这里的有效信息已经记录过了";
  if (outcome.status === "locked") return "当前还缺少进入这一步的前置线索";
  return "这次搜查没有发现可记录的新信息";
}

function demeanorLabel(value: string) {
  return (
    {
      calm: "平静",
      guarded: "戒备",
      evasive: "闪烁其词",
      agitated: "不安",
      cooperative: "配合",
      defiant: "强硬",
    }[value] ?? value
  );
}

function factTypeLabel(value: string) {
  return (
    {
      motive: "动机",
      method: "手法",
      opportunity: "机会",
      alibi: "不在场证明",
      relationship: "关系",
      context: "背景",
      identity: "身份",
    }[value] ?? value
  );
}

function characterName(view: GameView, characterId: string) {
  return (
    view.characters.find((character) => character.id === characterId)?.name ??
    (view.case.victim?.id === characterId ? view.case.victim.name : undefined) ??
    characterId
  );
}

function toggleValue(values: string[], value: string) {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

function reportIsComplete(report: ReportDraft) {
  return reportRequirements(report).length === 0;
}

function reportRequirements(report: ReportDraft) {
  const missing: string[] = [];
  if (!report.culpritId) missing.push("选择真凶");
  if (report.evidenceIds.length < 2) missing.push("勾选至少两条已发现证据");
  if (report.reasoning.trim().length < 10) {
    missing.push("写下至少 10 个字的推理陈述");
  }
  return missing;
}

function reportHasCompleteDossier(report: ReportResult) {
  return Object.values(report.correct).every(Boolean);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatSectionNumber(value: number) {
  return String(value).padStart(2, "0");
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function generationStatusText(job: GenerationJobView) {
  if (job.status === "succeeded") {
    return `《${job.result?.title ?? "新案件"}》已经归档，可以开始调查。`;
  }
  if (job.status === "failed") return generationFailureMessage(job);
  if (job.status === "cancelled") return "这次案件生成已取消。";
  return generationStageLabel(job);
}

function generationStageLabel(job: GenerationJobView) {
  if (job.status === "queued") return "正在准备案卷";
  if (job.status === "succeeded") return "案件已通过校验并归档";
  if (job.status === "failed") return "案件暂未通过校验";
  if (job.status === "cancelled") return "案件生成已取消";
  return (
    {
      starting: "正在展开案件设定",
      drafting: "正在编织案情",
      validating: "正在核对线索",
      repairing: "正在整理关键细节",
      blind_solving: "正在独立推演",
      finalizing: "正在封存卷宗",
    }[job.stage] ?? "正在细致整理案件"
  );
}

function generationProgressText(job: GenerationJobView) {
  if (job.status === "queued") {
    return "正在为这起案件安排人物、地点与最初的疑点。";
  }
  return (
    {
      starting: "案卷已展开，真相链正在从零开始成形。",
      drafting: "人物、场景和关键线索正在逐一归位。",
      validating: "正在确认每条线索都能指向同一个结论。",
      repairing: "发现一处需要核对的细节，正在让证据链保持自洽。",
      blind_solving: "另一条推理路径正在独立复盘案情。",
      finalizing: "通过检验的案件正在封存，很快可以启封调查。",
    }[job.stage] ?? "案件正在细致打磨，请稍候。"
  );
}

function generationFailureMessage(_job: GenerationJobView) {
  return "这起案件暂时未能完成生成。请重新提交，或换一个更具体的主题。";
}

function isGenerationTerminal(job: GenerationJobView) {
  return (
    job.status === "succeeded" ||
    job.status === "failed" ||
    job.status === "cancelled"
  );
}

function generationActualProgress(job: GenerationJobView) {
  if (job.status === "succeeded") return 100;
  return Math.max(0, Math.min(100, job.progress));
}

function generationDisplayTarget(
  status: GenerationJobView["status"],
  stage: GenerationJobView["stage"],
  actualProgress: number,
) {
  const stageTarget =
    status === "queued"
      ? 7
      : {
          starting: 14,
          drafting: 58,
          validating: 76,
          repairing: 84,
          blind_solving: 93,
          finalizing: 98,
        }[stage] ?? 16;
  return Math.min(98, Math.max(actualProgress, stageTarget));
}

function generationTerminalText(job: GenerationJobView) {
  if (job.status === "succeeded") {
    return `历时 ${formatElapsed(job.createdAt)} 完成归档，可以从上方“选择案件”启封。`;
  }
  if (job.status === "failed") {
    return generationFailureMessage(job);
  }
  return "这次案件生成已取消。";
}

function formatElapsed(value: string) {
  const delta = Math.max(0, Date.now() - Date.parse(value));
  if (!Number.isFinite(delta)) return "未知时长";
  const seconds = Math.floor(delta / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
