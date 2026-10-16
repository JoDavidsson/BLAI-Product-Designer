import { createProject, createNode, type WireNode, type Project } from './model';

function node(
  type: WireNode['type'],
  text: string,
  children: WireNode[] = [],
  style: WireNode['style'] = {},
): WireNode {
  return { ...createNode(type, text), children, style };
}
export function createSampleProject(): Project {
  const project = createProject('Wayfinder');
  project.summary =
    'A little less planning. A little more getting away. An example project to make your own.';
  project.plan = {
    problem:
      'Planning a short trip often means scattered tabs, saved places, and group messages. People spend more time organizing an escape than looking forward to it.',
    audience:
      'Curious travelers planning weekend trips alone or with a partner. They want a simple overview on desktop and a useful itinerary on their phone while away.',
    value:
      'Bring the places you want to go, the things you want to do, and the people you want to share them with into one calm, flexible trip plan.',
    goals:
      'Create a first trip in under two minutes. Make the next activity easy to find on mobile. Help people feel prepared without overplanning every hour.',
    scope:
      'Must have: create and edit trips; save places; organize a day-by-day itinerary; view upcoming trips; responsive desktop and mobile layouts. Next: invite a travel partner and share a read-only itinerary.',
    outOfScope:
      'Booking flights or accommodation, payment processing, social feeds, and AI booking agents are outside the first version.',
    journeys:
      '1. Open the overview and create a trip with a destination and dates.\n2. Add places and arrange them into days.\n3. Open today’s itinerary on your phone.\n4. Update or remove an activity as plans change.',
    dataRules:
      'A trip belongs to its creator and includes a title, destination, start/end dates, and itinerary items. Each item belongs to a day and may have a time, note, and location. End dates cannot precede start dates. Changes persist across sessions. Only the owner can edit in the first version.',
    integrations:
      'Start with manually entered locations. Map links can open the user’s preferred map application. No booking or payment integration is required.',
    acceptance:
      'Creating a valid trip adds it to the overview. Invalid dates show a specific error without losing input. Reordering activities persists after reload. An empty itinerary offers a clear add-activity action. Mobile navigation remains usable on a 375px-wide screen.',
    questions:
      'Should activities have exact times or just an order within a day? Should completed trips remain visible on the overview?',
  };
  project.design = {
    accent: '#4c7669',
    background: '#f6f5f0',
    surface: '#ffffff',
    text: '#273b35',
    muted: '#819088',
    radius: 16,
    font: 'sans',
  };
  const desktopId = 'screen_overview';
  const tripId = 'screen_trip';
  const emptyId = 'screen_empty';
  const openTrip = node('button', 'Open itinerary');
  openTrip.action = { screenId: tripId };
  const createTrip = node('button', '+ Plan a new trip');
  createTrip.action = { screenId: emptyId };
  const card = (name: string, detail: string, color: string) =>
    node(
      'card',
      '',
      [
        node('badge', 'UPCOMING'),
        node('heading', name, [], { fontSize: 24 }),
        node('text', detail),
        name === 'A weekend in Copenhagen' ? openTrip : node('button', 'View trip'),
      ],
      { background: color, padding: 24 },
    );
  project.screens = [
    {
      id: desktopId,
      name: 'Trip overview',
      platform: 'desktop',
      description: 'The starting point: upcoming trips and a clear path to the next adventure.',
      state: 'default',
      nodes: [
        node('nav', 'wayfinder     Your trips    Saved places'),
        node(
          'section',
          '',
          [
            node('badge', 'YOUR NEXT CHAPTER'),
            node('heading', 'Somewhere good\nis waiting.', [], { fontSize: 38 }),
            node('text', 'Make room for a little adventure. All your plans, in one calm place.'),
            createTrip,
          ],
          { padding: 32 },
        ),
        node(
          'section',
          '',
          [
            node('heading', 'Your upcoming trips', [], { fontSize: 20 }),
            node('row', '', [
              card('A weekend in Copenhagen', 'May 23–25 · 3 days · 8 saved places', '#eaf0e8'),
              card('Slow days in Lisbon', 'June 12–17 · 6 days · 12 saved places', '#f4ece0'),
            ]),
          ],
          { padding: 24 },
        ),
        node('text', 'A good plan leaves a little room for getting lost.', [], {
          color: '#819088',
        }),
      ],
    },
    {
      id: tripId,
      name: 'Today’s itinerary',
      platform: 'mobile',
      description:
        'A pocket-sized itinerary for exploring without checking a dozen different apps.',
      state: 'default',
      nodes: [
        node('nav', '‹ Your trips                ···'),
        node(
          'section',
          '',
          [
            node('badge', 'COPENHAGEN · DAY 1'),
            node('heading', 'Take the\nscenic route.', [], { fontSize: 32 }),
            node('text', 'Friday, May 23 · A day for wandering'),
          ],
          { background: '#eaf0e8', padding: 24 },
        ),
        node(
          'section',
          '',
          [
            node('heading', 'Today, at your pace', [], { fontSize: 18 }),
            node('card', '', [
              node('badge', '09:30 · A SLOW START'),
              node('heading', 'Coffee at Atelier September', [], { fontSize: 17 }),
              node('text', 'A good coffee and nowhere to rush.'),
            ]),
            node('card', '', [
              node('badge', '11:00 · EXPLORE'),
              node('heading', 'Walk along Nyhavn', [], { fontSize: 17 }),
              node('text', 'Follow the water. Stop wherever you like.'),
            ]),
            node('button', '+ Add a little something'),
          ],
          { padding: 20 },
        ),
      ],
    },
    {
      id: emptyId,
      name: 'A fresh itinerary',
      platform: 'mobile',
      description: 'An encouraging empty state that makes the first step feel small.',
      state: 'empty',
      nodes: [
        node('nav', '‹ Your trips'),
        node(
          'section',
          '',
          [
            node('badge', 'A BLANK PAGE'),
            node('heading', 'Every good trip\nstarts somewhere.', [], { fontSize: 30 }),
            node('text', 'Add a place you’ve been meaning to visit. The rest can follow.'),
            node('button', '+ Add your first place'),
          ],
          { padding: 28 },
        ),
      ],
    },
  ];
  project.comments = [
    {
      id: 'comment_create_trip',
      target: { kind: 'node', screenId: desktopId, nodeId: createTrip.id, x: 0.5, y: 0.5 },
      body: 'Creating a trip should ask for a destination and date range. Keep it short: the itinerary can be filled in later.',
      status: 'accepted',
      replies: [],
      createdAt: project.createdAt,
      requirementId: 'req_create_trip',
    },
  ];
  project.requirements = [
    {
      id: 'req_create_trip',
      text: 'Creating a trip asks for a destination and valid date range. Itinerary details are optional at creation.',
      sourceCommentId: 'comment_create_trip',
      screenId: desktopId,
      status: 'accepted',
    },
  ];
  return project;
}
