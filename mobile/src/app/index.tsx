import { Redirect } from 'expo-router';
import { landing } from '../routes.ts';
import { useStatus } from '../store/index.ts';

export default function Index() {
  return <Redirect href={landing(useStatus().signedIn)} />;
}
