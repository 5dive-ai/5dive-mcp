import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { client } from "./api";
import type { Task } from "./fivedive";

const STATUS: Record<string, { title: string; color: Color }> = {
  in_progress: { title: "Working", color: Color.Blue },
  blocked: { title: "Blocked", color: Color.Red },
  todo: { title: "To do", color: Color.SecondaryText },
  parked: { title: "Parked", color: Color.Yellow },
};

export default function Command() {
  const { data, isLoading, revalidate } = useCachedPromise(() => client().listTasks(), []);
  const groups: [string, Task[]][] = ["in_progress", "blocked", "todo", "parked"].map((s) => [
    s,
    (data ?? []).filter((t) => t.status === s),
  ]);
  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search tasks">
      {groups.map(([s, tasks]) => (
        <List.Section key={s} title={STATUS[s]?.title ?? s} subtitle={String(tasks.length)}>
          {tasks.map((t) => (
            <List.Item
              key={t.task}
              title={t.title}
              subtitle={t.task}
              accessories={[
                ...(t.waiting_on ? [{ tag: { value: `needs you: ${t.waiting_on}`, color: Color.Orange } }] : []),
                { text: t.assignee ?? "unassigned", icon: Icon.Person },
              ]}
              actions={
                <ActionPanel>
                  <Action.CopyToClipboard title="Copy Task ID" content={t.task} />
                  <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={revalidate} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ))}
    </List>
  );
}
