import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useClient, useInbox } from "../api/provider";
import { Async, Button, Card, Empty, ErrorNote, Input } from "../components/ui";
import { timeAgo } from "../format";

function Reply({ label, onSend }: { label: string; onSend: (text: string) => Promise<unknown> }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const m = useMutation({
    mutationFn: () => onSend(text),
    onSuccess: () => {
      setText("");
      void qc.invalidateQueries({ queryKey: ["inbox"] });
      void qc.invalidateQueries({ queryKey: ["town"] });
    },
  });
  return (
    <form
      className="mt-2 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <Input
        aria-label={label}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={label}
      />
      <Button type="submit" disabled={m.isPending || !text.trim()}>
        Send
      </Button>
      <div className="basis-full">
        <ErrorNote error={m.error} />
      </div>
    </form>
  );
}

/** Everything waiting on the Sovereign. Escalations climb member → foreman → executive → Mayor → you. */
export function InboxPage() {
  const inbox = useInbox();
  const client = useClient();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Waiting on you</h1>
      <Async q={inbox}>
        {(i) => (
          <>
            <Card title={`Questions (${i.questions.length})`}>
              {i.questions.length === 0 ? (
                <Empty>No worker is waiting for an answer.</Empty>
              ) : (
                <ul className="divide-y divide-bark-100">
                  {i.questions.map((q) => (
                    <li key={q.questionId} className="py-3">
                      <p className="font-medium">{q.text}</p>
                      <p className="text-xs text-bark-500">{timeAgo(q.at)}</p>
                      <Reply
                        label="Your answer"
                        onSend={(a) => client.answerQuestion(q.questionId, a)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title={`Escalations (${i.escalations.length})`}>
              {i.escalations.length === 0 ? (
                <Empty>Nothing has been escalated to you.</Empty>
              ) : (
                <ul className="divide-y divide-bark-100">
                  {i.escalations.map((x) => (
                    <li key={x.escalationId} className="py-3">
                      <p className="font-medium">{x.reason}</p>
                      <p className="text-xs text-bark-500">
                        at the {x.level} level · {timeAgo(x.at)}
                      </p>
                      <Reply
                        label="How it was resolved"
                        onSend={(r) => client.resolveEscalation(x.escalationId, r)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </Async>
    </div>
  );
}
