// Compiled by `npm run lint`: keep both sides of the Socket.IO contract checked.
import type { Socket as ServerSocket } from 'socket.io';
import type { Socket as ClientSocket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../src/lib/socketContract.ts';

function checkSocketContract(
  server: ServerSocket<ClientToServerEvents, ServerToClientEvents>,
  client: ClientSocket<ServerToClientEvents, ClientToServerEvents>,
) {
  client.emit('teacher:auth', { pin: '1234' }, (result) => {
    const ok: boolean = result.ok;
    void ok;
    // @ts-expect-error Authentication acknowledgments do not contain a room ID.
    result.roomId;
  });
  server.emit('board-full', { boardId: 'main', max: 10000 });
  // @ts-expect-error Event names must match the contract.
  client.emit('teacher:authenticate', { pin: '1234' });
  // @ts-expect-error Laser pulses must include a stroke ID.
  client.emit('laser-pulse', { boardId: 'main', x: 1, y: 2 });
  // @ts-expect-error Board-full notifications require a numeric limit.
  server.emit('board-full', { boardId: 'main', max: '10000' });
}
void checkSocketContract;
