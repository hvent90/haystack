import { Send } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { CharacterCard, WorldSnapshot } from "../../../../shared/types";
import { chatChannels } from "../../constants";
import type { ChatChannel } from "../../types";

export function CommsWindow({
  snapshot,
  me,
  channel,
  targetPilotId,
  draft,
  messages,
  busy,
  onChannel,
  onTarget,
  onDraft,
  onSend,
}: {
  snapshot: WorldSnapshot;
  me: CharacterCard;
  channel: ChatChannel;
  targetPilotId: string;
  draft: string;
  messages: WorldSnapshot["chat"];
  busy: boolean;
  onChannel: (channel: ChatChannel) => void;
  onTarget: (pilotId: string) => void;
  onDraft: (draft: string) => void;
  onSend: () => void;
}): ReactNode {
  const logRef = useRef<HTMLDivElement>(null);
  const activePilotIds = new Set(snapshot.activePilotIds);
  activePilotIds.add(me.id);
  const activePilots = snapshot.pilots.filter((pilot) => activePilotIds.has(pilot.id));

  useEffect(() => {
    const log = logRef.current;
    if (log === null) {
      return;
    }
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    if (atBottom) {
      log.scrollTop = log.scrollHeight;
    }
  }, [messages.length]);

  return (
    <div className="comms-layout">
      <div className="comms-main">
        <div className="comms-tabs" role="tablist">
          {chatChannels.map((nextChannel) => (
            <button
              type="button"
              key={nextChannel}
              data-testid={`comms-tab-${nextChannel}`}
              aria-selected={channel === nextChannel}
              data-active={channel === nextChannel}
              onClick={() => onChannel(nextChannel)}
            >
              {nextChannel}
            </button>
          ))}
        </div>
        {channel === "dm" ? (
          <select
            data-testid="comms-dm-target"
            value={targetPilotId}
            onChange={(event) => onTarget(event.currentTarget.value)}
          >
            <option value="">select pilot</option>
            {activePilots
              .filter((pilot) => pilot.id !== me.id)
              .map((pilot) => (
                <option key={pilot.id} value={pilot.id}>
                  {pilot.callsign}
                </option>
              ))}
          </select>
        ) : null}
        <div className="comms-log" data-testid="comms-log" ref={logRef}>
          {messages.map((message) => (
            <div key={message.id} className="comms-msg" data-testid="comms-msg">
              <b>{message.fromCallsign}</b>
              <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
              <span>{message.body}</span>
            </div>
          ))}
          {messages.length === 0 ? <span className="empty">no traffic</span> : null}
        </div>
        <div className="chat-input">
          <input
            data-testid="comms-input"
            value={draft}
            onChange={(event) => onDraft(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && onSend()}
          />
          <button
            type="button"
            data-testid="comms-send"
            aria-label="Send message"
            title="Send"
            data-busy={busy}
            aria-busy={busy}
            disabled={draft.trim().length === 0 || (channel === "dm" && targetPilotId.length === 0)}
            onClick={onSend}
          >
            <Send size={15} />
          </button>
        </div>
      </div>
      <aside className="local-list">
        <div className="local-count" data-testid="comms-local-count">
          {activePilots.length} local
        </div>
        <div data-testid="comms-local-list">
          {activePilots.map((pilot) => (
            <div
              key={pilot.id}
              className={pilot.id === me.id ? "local-row me" : "local-row"}
              data-testid={`comms-local-${pilot.id}`}
              data-me={pilot.id === me.id}
            >
              <b>{pilot.callsign}</b>
              <small>{pilot.organization}</small>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
