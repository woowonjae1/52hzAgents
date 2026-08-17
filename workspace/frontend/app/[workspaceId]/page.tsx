import { WorkspaceClient } from './workspace-client';

export function generateStaticParams() {
  return [{ workspaceId: 'default' }];
}

export default function WorkspacePage(props: {
  params: Promise<{ workspaceId: string }>;
}) {
  return <WorkspaceClient params={props.params} />;
}
