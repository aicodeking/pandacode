import { Redirect } from 'expo-router';
import { useStatus } from '../store/index.ts';

export default function Index() {
  return <Redirect href={useStatus().signedIn ? '/inbox' : '/sign-in'} />;
}
