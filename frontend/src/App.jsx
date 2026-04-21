import HostStudio from './studio/HostStudio.jsx'

// HostStudio is the only entry point as of Phase 6 cutover.
// Legacy VideoGenerator/ConversationGenerator deleted; QueueStatus lives inside studio/.
export default function App() {
  return <HostStudio />
}
