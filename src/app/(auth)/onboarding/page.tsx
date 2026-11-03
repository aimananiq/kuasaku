import { createClient } from '@/lib/supabase/server';
import { hasSupabaseEnv } from '@/lib/auth/preview-mode';
import { OnboardingFlow } from './onboarding-flow';

export default async function OnboardingPage() {
  // Someone who signed in with Google (or any non-demo account) but has no
  // workspace yet only needs to name one; they must not set a password here.
  let signedInEmail: string | null = null;
  if (hasSupabaseEnv()) {
    try {
      const supabase = await createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user && !user.is_anonymous) signedInEmail = user.email ?? 'your account';
    } catch {
      // Treated as signed out: the full sign-up form is shown.
    }
  }
  return <OnboardingFlow signedInEmail={signedInEmail} />;
}
