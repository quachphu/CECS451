import { redirect } from 'next/navigation';
import { getAuthUser } from '@/lib/auth';
import Sidebar from '@/components/layout/Sidebar';
import Footer from '@/components/layout/Footer';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect('/login');

  return (
    <div className="min-h-screen bg-slate-50 flex">
      <Sidebar userName={user.name} />
      <div className="flex-1 lg:ml-64 flex flex-col min-h-screen">
        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-8 pt-20 lg:pt-8">{children}</main>
        <Footer />
      </div>
    </div>
  );
}
