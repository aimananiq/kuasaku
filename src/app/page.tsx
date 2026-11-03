import { redirect } from 'next/navigation';

// The landing page is removed: opening the site goes straight to sign-in.
export default function RootPage() {
  redirect('/login');
}
