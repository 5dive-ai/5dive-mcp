import type {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from "n8n-workflow";
import { NodeConnectionTypes, NodeOperationError } from "n8n-workflow";
import { FiveDive as FiveDiveClient, type Priority } from "./fivedive";

export class FiveDive implements INodeType {
  description: INodeTypeDescription = {
    displayName: "5dive",
    name: "fiveDive",
    icon: "file:fivedive.svg",
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: "Hand a task to your 5dive AI agent team and read its status",
    defaults: { name: "5dive" },
    usableAsTool: true,
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "fiveDiveApi", required: true }],
    properties: [
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        options: [
          { name: "Create Task", value: "create", action: "Create a task", description: "Give your team a new task" },
          { name: "Get Status", value: "get", action: "Get a task's status", description: "Read one task by its ID" },
        ],
        default: "create",
      },
      {
        displayName: "Title",
        name: "title",
        type: "string",
        default: "",
        required: true,
        placeholder: "Draft this week's newsletter",
        displayOptions: { show: { operation: ["create"] } },
      },
      {
        displayName: "Agent",
        name: "agent",
        type: "string",
        default: "",
        placeholder: "main",
        description: "Agent to give it to. Leave empty to put it in the team queue.",
        displayOptions: { show: { operation: ["create"] } },
      },
      {
        displayName: "Priority",
        name: "priority",
        type: "options",
        options: [
          { name: "Low", value: "low" },
          { name: "Medium", value: "medium" },
          { name: "High", value: "high" },
        ],
        default: "medium",
        displayOptions: { show: { operation: ["create"] } },
      },
      {
        displayName: "Details",
        name: "details",
        type: "string",
        typeOptions: { rows: 4 },
        default: "",
        displayOptions: { show: { operation: ["create"] } },
      },
      {
        displayName: "Task ID",
        name: "task",
        type: "string",
        default: "",
        required: true,
        placeholder: "DIVE-123",
        displayOptions: { show: { operation: ["get"] } },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const creds = await this.getCredentials("fiveDiveApi");
    const client = new FiveDiveClient({
      apiKey: String(creds.apiKey ?? ""),
      baseUrl: String(creds.baseUrl ?? ""),
      userAgent: "n8n-nodes-5dive",
    });
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const op = this.getNodeParameter("operation", i) as string;
        const json =
          op === "create"
            ? await client.createTask({
                title: this.getNodeParameter("title", i) as string,
                agent: this.getNodeParameter("agent", i, "") as string,
                priority: this.getNodeParameter("priority", i, "medium") as Priority,
                details: this.getNodeParameter("details", i, "") as string,
              })
            : await client.getTask(this.getNodeParameter("task", i) as string);
        out.push({ json: json as unknown as IDataObject, pairedItem: { item: i } });
      } catch (err) {
        if (this.continueOnFail()) {
          out.push({ json: { error: (err as Error).message }, pairedItem: { item: i } });
          continue;
        }
        throw new NodeOperationError(this.getNode(), err as Error, { itemIndex: i });
      }
    }
    return [out];
  }
}

