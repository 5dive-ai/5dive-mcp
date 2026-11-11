import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { client } from "./api";

export default function Command() {
  const { data, isLoading, revalidate } = useCachedPromise(() => client().teamStatus(), []);
  const working = new Map((data?.in_progress ?? []).map((t) => [t.assignee, t]));
  return (
    <List isLoading={isLoading}>
      {(data?.needs_you.length ?? 0) > 0 && (
        <List.Section title="Waiting on you">
          {data!.needs_you.map((n) => (
            <List.Item
              key={n.task}
              icon={{ source: Icon.Bell, tintColor: Color.Orange }}
              title={n.question || n.title}
              subtitle={n.task}
              actions={
                <ActionPanel>
                  <Action.OpenInBrowser title="Answer on Dashboard" url={n.answer_at} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
      <List.Section title="Agents">
        {(data?.agents ?? []).map((a) => {
          const t = working.get(a.agent);
          return (
            <List.Item
              key={a.agent}
              icon={Icon.Person}
              title={a.agent}
              subtitle={t ? `${t.task} ${t.title}` : (a.last_seen ?? "")}
              accessories={[{ tag: a.state ?? "unknown" }, ...(a.model ? [{ text: a.model }] : [])]}
              actions={
                <ActionPanel>
                  <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={revalidate} />
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    </List>
  );
}
