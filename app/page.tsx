export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">AI Curator</h1>
        <p className="mt-2 text-sm text-gray-500">
          Service is running. Health check: <code>/api/health</code>
        </p>
      </div>
    </main>
  );
}
