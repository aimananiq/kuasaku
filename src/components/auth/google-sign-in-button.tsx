'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { googleSignInAction, type AuthState } from '@/app/(auth)/actions';

export function GoogleSignInButton({ children }: { children: React.ReactNode }) {
  const [state, formAction, pending] = useActionState<AuthState, FormData>(
    googleSignInAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-2">
      <Button
        type="submit"
        variant="outline"
        className="w-full"
        size="lg"
        disabled={pending}
      >
        {children}
      </Button>
      {state?.error ? (
        <p role="status" className="text-center text-sm text-muted-foreground">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
