import { Action, ActionPanel, Form, Toast, popToRoot, showToast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState } from "react";
import { client } from "./api";
import type { Priority } from "./fivedive";

interface Values {
  title: string;
  agent: string;
  priority: Priority;
  details: string;
}

export default function Command() {
  const { data: agents, isLoading } = useCachedPromise(() => client().listAgents(), []);
  const [titleError, setTitleError] = useState<string | undefined>();

  async function submit(values: Values) {
    if (!values.title.trim()) {
      setTitleError("A task needs a title");
      return;
    }
    const toast = await showToast({ style: Toast.Style.Animated, title: "Assigning…" });
    try {
      const t = await client().createTask({
        title: values.title,
        agent: values.agent || undefined,
        priority: values.priority,
        details: values.details,
      });
      toast.style = Toast.Style.Success;
      toast.title = `${t.task} created`;
      toast.message = t.assignee ? `Assigned to ${t.assignee}` : "In the team queue";
      await popToRoot();
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = "Could not create the task";
      toast.message = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Assign Task" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="Task"
        placeholder="Draft this week's newsletter"
        error={titleError}
        onChange={() => setTitleError(undefined)}
      />
      <Form.Dropdown id="agent" title="Agent" defaultValue="">
        <Form.Dropdown.Item value="" title="Team queue (anyone)" />
        {(agents ?? []).map((a) => (
          <Form.Dropdown.Item key={a.agent} value={a.agent} title={a.agent} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown id="priority" title="Priority" defaultValue="medium">
        <Form.Dropdown.Item value="low" title="Low" />
        <Form.Dropdown.Item value="medium" title="Medium" />
        <Form.Dropdown.Item value="high" title="High" />
        <Form.Dropdown.Item value="urgent" title="Urgent" />
      </Form.Dropdown>
      <Form.TextArea id="details" title="Details" placeholder="Links, what done looks like…" />
    </Form>
  );
}
