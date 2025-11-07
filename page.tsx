// app/page.tsx
import { redirect } from 'next/navigation';

export default function Page() {
  // Redirige a la página de login; ajusta a "/dashboard" si prefieres ir al panel principal
  redirect('/login');
  return null;
}
