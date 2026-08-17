import { ShareClient } from './share-client';

export function generateStaticParams() {
  return [{ token: 'default' }];
}

export default function SharePage(props: {
  params: Promise<{ token: string }>;
}) {
  return <ShareClient params={props.params} />;
}
