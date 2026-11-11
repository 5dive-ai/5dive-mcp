import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from "n8n-workflow";

export class FiveDiveApi implements ICredentialType {
  name = "fiveDiveApi";
  displayName = "5dive API";
  icon = "file:fivedive.svg" as const;
  documentationUrl = "https://github.com/5dive-ai/5dive-mcp/tree/main/integrations/n8n-nodes-5dive#credentials";
  properties: INodeProperties[] = [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      description:
        "Create one in 5dive under Settings, API keys. To create tasks, allow it to act on your team.",
    },
    {
      displayName: "Base URL",
      name: "baseUrl",
      type: "string",
      default: "https://api.5dive.com",
    },
  ];
  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: { headers: { Authorization: "=Bearer {{$credentials.apiKey}}" } },
  };
  test: ICredentialTestRequest = {
    request: { baseURL: "={{$credentials.baseUrl}}", url: "/v1/agents" },
  };
}
