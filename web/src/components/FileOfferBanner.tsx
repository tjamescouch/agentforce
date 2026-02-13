import type { DashboardState, DashboardAction, WsSendFn } from '../types';
import { agentColor, formatSize } from '../utils';

interface FileOfferBannerProps {
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
  send: WsSendFn;
}

export function FileOfferBanner({ state, dispatch, send }: FileOfferBannerProps) {
  const offers = Object.values(state.transfers).filter(
    t => t.direction === 'in' && t.status === 'offered'
  );
  if (offers.length === 0) return null;

  return (
    <>
      {offers.map(offer => (
        <div key={offer.id} className="file-offer-banner">
          <div className="offer-info">
            <span className="offer-from" style={{ color: agentColor(offer.peerNick || offer.peer) }}>
              {offer.peerNick || offer.peer}
            </span>
            <span> wants to send </span>
            <span className="offer-files">
              {offer.files.length} file{offer.files.length !== 1 ? 's' : ''} ({formatSize(offer.totalSize)})
            </span>
          </div>
          <div className="offer-file-names">
            {offer.files.map((f, i) => (
              <span key={i} className="offer-file-tag">{f.name}</span>
            ))}
          </div>
          <div className="offer-actions">
            <button
              className="offer-btn accept"
              onClick={() => send({ type: 'file_respond', data: { transferId: offer.id, accept: true } })}
            >
              Accept
            </button>
            <button
              className="offer-btn reject"
              onClick={() => {
                send({ type: 'file_respond', data: { transferId: offer.id, accept: false } });
                const updated = { ...offer, status: 'rejected' as const };
                dispatch({ type: 'TRANSFER_UPDATE', data: updated });
              }}
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
