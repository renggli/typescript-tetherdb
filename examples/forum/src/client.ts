import {
  AuthStatus,
  type Index,
  type StoredRecord,
  SyncStatus,
  type Table,
  type TableChangeEvent,
  TetherClient,
} from 'tetherdb/client';

/**
 * Community category metadata model.
 */
export interface CommunityItem {
  id: string;
  name: string;
  description: string;
  icon: string;
  createdAt: number;
}

/**
 * Unified forum post model.
 * Root posts have no `parentId` and define a `title`.
 * Child posts (nested comments/replies) specify a `parentId`.
 */
export interface PostItem {
  community: string;
  parentId?: string;
  title?: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Vote item for posts and nested replies.
 */
export interface VoteItem {
  targetId: string;
  value: 1 | -1;
  createdAt: number;
}

/**
 * Sort options for the post feed.
 */
enum SortMode {
  Hot = 'hot',
  New = 'new',
  Top = 'top',
}

// -----------------------------------------------------------------------------
// Database & State Management
// -----------------------------------------------------------------------------

const db = new TetherClient('forum-example');

const communitiesTable: Table<CommunityItem> =
  db.table<CommunityItem>('communities');
const postsTable: Table<PostItem> = db.table<PostItem>('posts');
const votesTable: Table<VoteItem> = db.table<VoteItem>('votes');

const communityIndex: Index<PostItem, string> =
  postsTable.index<string>('community');
const parentIndex: Index<PostItem, string> =
  postsTable.index<string>('parentId');
const targetVotesIndex: Index<VoteItem, string> =
  votesTable.index<string>('targetId');

let activeCommunity = 'all';
let currentSort: SortMode = SortMode.Hot;
let activePostId: string | null = null;
let authMode: 'signin' | 'register' = 'signin';

const communityMap = new Map<string, CommunityItem>();

// Render tokens for sequencing and preventing race conditions
let renderPostsVersion = 0;
let renderRepliesVersion = 0;
let renderCommunitiesVersion = 0;

let scheduledPostsTimer: ReturnType<typeof setTimeout> | null = null;
let scheduledRepliesTimer: ReturnType<typeof setTimeout> | null = null;
let scheduledCommunitiesTimer: ReturnType<typeof setTimeout> | null = null;

// -----------------------------------------------------------------------------
// DOM Element References
// -----------------------------------------------------------------------------

const statusPill = document.getElementById('statusPill') as HTMLDivElement;
const statusText = document.getElementById('statusText') as HTMLSpanElement;

// Auth Navbar Controls
const authButton = document.getElementById('authButton') as HTMLButtonElement;
const authButtonAvatar = document.getElementById(
  'authButtonAvatar',
) as HTMLSpanElement;
const authButtonText = document.getElementById(
  'authButtonText',
) as HTMLSpanElement;

const ICON_USER_OUTLINE =
  '<svg class="auth-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><title>Signed out user</title><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

const ICON_USER_FILLED =
  '<svg class="auth-icon" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><title>Signed in user</title><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';

// Auth Modal Controls
const authModalDialog = document.getElementById(
  'authModalDialog',
) as HTMLDialogElement;
const authModalTitle = document.getElementById(
  'authModalTitle',
) as HTMLHeadingElement;
const authSignedInSection = document.getElementById(
  'authSignedInSection',
) as HTMLDivElement;
const modalUserNameText = document.getElementById(
  'modalUserNameText',
) as HTMLSpanElement;
const modalSignOutBtn = document.getElementById(
  'modalSignOutBtn',
) as HTMLButtonElement;
const closeAuthModalBtn = document.getElementById(
  'closeAuthModalBtn',
) as HTMLButtonElement;
const cancelAuthModalBtn = document.getElementById(
  'cancelAuthModalBtn',
) as HTMLButtonElement;
const authTabSignIn = document.getElementById(
  'authTabSignIn',
) as HTMLButtonElement;
const authTabRegister = document.getElementById(
  'authTabRegister',
) as HTMLButtonElement;
const authForm = document.getElementById('authForm') as HTMLFormElement;
const authUserNameInput = document.getElementById(
  'authUserNameInput',
) as HTMLInputElement;
const authPasswordInput = document.getElementById(
  'authPasswordInput',
) as HTMLInputElement;
const authErrorMessage = document.getElementById(
  'authErrorMessage',
) as HTMLDivElement;
const submitAuthBtn = document.getElementById(
  'submitAuthBtn',
) as HTMLButtonElement;
const quickUserChips =
  document.querySelectorAll<HTMLButtonElement>('.chip-btn');

// Sidebar
const communityList = document.getElementById(
  'communityList',
) as HTMLUListElement;
const feedList = document.getElementById('feedList') as HTMLUListElement;

// Main Content Views
const feedView = document.getElementById('feedView') as HTMLDivElement;
const threadView = document.getElementById('threadView') as HTMLDivElement;
const backToFeedBtn = document.getElementById(
  'backToFeedBtn',
) as HTMLButtonElement;

const bannerIcon = document.getElementById('bannerIcon') as HTMLDivElement;
const bannerTitle = document.getElementById(
  'bannerTitle',
) as HTMLHeadingElement;
const bannerDesc = document.getElementById(
  'bannerDesc',
) as HTMLParagraphElement;

const openCreatePostBtn = document.getElementById(
  'openCreatePostBtn',
) as HTMLButtonElement;
const sortBtns = document.querySelectorAll<HTMLButtonElement>('.sort-btn');
const postFeed = document.getElementById('postFeed') as HTMLDivElement;
const emptyFeedState = document.getElementById(
  'emptyFeedState',
) as HTMLDivElement;
const emptyCreatePostBtn = document.getElementById(
  'emptyCreatePostBtn',
) as HTMLButtonElement;

// Create Post Dialog
const createPostDialog = document.getElementById(
  'createPostDialog',
) as HTMLDialogElement;
const closeCreatePostModalBtn = document.getElementById(
  'closeCreatePostModalBtn',
) as HTMLButtonElement;
const cancelCreatePostBtn = document.getElementById(
  'cancelCreatePostBtn',
) as HTMLButtonElement;
const createPostForm = document.getElementById(
  'createPostForm',
) as HTMLFormElement;
const postCommunitySelect = document.getElementById(
  'postCommunitySelect',
) as HTMLSelectElement;
const postTitleInput = document.getElementById(
  'postTitleInput',
) as HTMLInputElement;
const postContentInput = document.getElementById(
  'postContentInput',
) as HTMLTextAreaElement;

// Edit Post Dialog
const editPostDialog = document.getElementById(
  'editPostDialog',
) as HTMLDialogElement;
const closeEditPostModalBtn = document.getElementById(
  'closeEditPostModalBtn',
) as HTMLButtonElement;
const cancelEditPostBtn = document.getElementById(
  'cancelEditPostBtn',
) as HTMLButtonElement;
const editPostForm = document.getElementById('editPostForm') as HTMLFormElement;
const editPostIdInput = document.getElementById(
  'editPostIdInput',
) as HTMLInputElement;
const editPostTitleGroup = document
  .getElementById('editPostTitleInput')
  ?.closest('.form-group') as HTMLElement | null;
const editPostTitleInput = document.getElementById(
  'editPostTitleInput',
) as HTMLInputElement;
const editPostContentInput = document.getElementById(
  'editPostContentInput',
) as HTMLTextAreaElement;

// In-Body Thread View Elements
const threadHeaderMeta = document.getElementById(
  'threadHeaderMeta',
) as HTMLDivElement;
const threadVoteColumn = document.getElementById(
  'threadVoteColumn',
) as HTMLDivElement;
const threadPostTitle = document.getElementById(
  'threadPostTitle',
) as HTMLHeadingElement;
const threadPostContent = document.getElementById(
  'threadPostContent',
) as HTMLDivElement;
const newCommentForm = document.getElementById(
  'newCommentForm',
) as HTMLFormElement;
const newCommentInput = document.getElementById(
  'newCommentInput',
) as HTMLTextAreaElement;
const commentsList = document.getElementById('commentsList') as HTMLDivElement;
const emptyCommentsState = document.getElementById(
  'emptyCommentsState',
) as HTMLDivElement;
const threadCommentCountBadge = document.getElementById(
  'threadCommentCountBadge',
) as HTMLSpanElement;

// -----------------------------------------------------------------------------
// Helpers & Logging
// -----------------------------------------------------------------------------

/**
 * Logs mutation events to the browser console.
 */
function logMutation(origin: string, message: string): void {
  console.info(
    `%c[TetherDB ${origin}]%c ${message}`,
    'color: #ff4500; font-weight: bold;',
    'color: inherit;',
  );
}

/**
 * Gets the display name for a post/comment author.
 */
function getAuthorName(userName?: string): string {
  return userName ?? 'anonymous';
}

/**
 * Escapes HTML characters in user-provided strings.
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Formats a relative timestamp (e.g. "2m ago", "1h ago").
 */
function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

/**
 * Gets the display name for a community ID.
 */
function getCommunityName(communityId: string): string {
  return communityMap.get(communityId)?.name ?? communityId;
}

/**
 * Gets the authenticated user's username, or `undefined` if signed out.
 */
function getCurrentUserName(): string | undefined {
  return db.authStatus === AuthStatus.SignedIn ? db.userName : undefined;
}

/**
 * Checks if the current authenticated user is the owner of a record based on metadata `userName`.
 */
function isRecordOwner(record: StoredRecord<unknown>): boolean {
  if (db.authStatus !== AuthStatus.SignedIn) return false;
  const currentUserName = getCurrentUserName();
  return Boolean(
    currentUserName && record.userName && record.userName === currentUserName,
  );
}

interface VoteSummary {
  score: number;
  upvotes: number;
  downvotes: number;
  userVote: number;
  userVoteRecordId?: string;
}

/**
 * Calculates unique upvotes, downvotes, net score, and user vote status for a target post/reply.
 * Deduplicates multiple vote entries per user by retaining the latest timestamp.
 */
async function getVoteSummary(
  targetId: string,
  currentUserName?: string,
): Promise<VoteSummary> {
  const votes = await targetVotesIndex.getAllWithMetadata(targetId);
  const userLatestVote = new Map<
    string,
    { value: number; id: string; timestamp: number }
  >();

  for (const record of votes) {
    const voter = record.userName ?? record.id;
    const existing = userLatestVote.get(voter);
    if (!existing || record.timestamp >= existing.timestamp) {
      userLatestVote.set(voter, {
        value: record.data.value,
        id: record.id,
        timestamp: record.timestamp,
      });
    }
  }

  let upvotes = 0;
  let downvotes = 0;
  let userVote = 0;
  let userVoteRecordId: string | undefined;

  for (const [voter, vote] of userLatestVote.entries()) {
    if (vote.value === 1) upvotes++;
    if (vote.value === -1) downvotes++;
    if (currentUserName && voter === currentUserName) {
      userVote = vote.value;
      userVoteRecordId = vote.id;
    }
  }

  return {
    score: upvotes - downvotes,
    upvotes,
    downvotes,
    userVote,
    userVoteRecordId,
  };
}

/**
 * Recursively counts all descendant reply posts for a given parent post.
 */
async function countDescendants(postId: string): Promise<number> {
  const children = await parentIndex.getPrimaryKeys(postId);
  let count = children.length;
  for (const childId of children) {
    count += await countDescendants(childId);
  }
  return count;
}

// -----------------------------------------------------------------------------
// Render Scheduling (Debounced & Race-Condition Proof)
// -----------------------------------------------------------------------------

function scheduleRenderPosts(): void {
  if (scheduledPostsTimer) return;
  scheduledPostsTimer = setTimeout(() => {
    scheduledPostsTimer = null;
    renderPosts();
  }, 16);
}

function scheduleRenderReplies(): void {
  if (!activePostId || scheduledRepliesTimer) return;
  scheduledRepliesTimer = setTimeout(() => {
    scheduledRepliesTimer = null;
    if (activePostId) {
      renderReplies(activePostId);
      updateThreadVoteUI(activePostId);
    }
  }, 16);
}

function scheduleRenderCommunities(): void {
  if (scheduledCommunitiesTimer) return;
  scheduledCommunitiesTimer = setTimeout(() => {
    scheduledCommunitiesTimer = null;
    renderCommunities();
  }, 16);
}

// -----------------------------------------------------------------------------
// UI Rendering
// -----------------------------------------------------------------------------

/**
 * Updates authentication button and modal content.
 */
function updateAuthUI(): void {
  if (db.authStatus === AuthStatus.SignedIn && db.userName) {
    authButtonAvatar.innerHTML = ICON_USER_FILLED;
    authButtonText.textContent = db.userName;
    authButton.classList.add('signed-in');
    authSignedInSection.style.display = 'block';
    modalUserNameText.textContent = db.userName;
    authModalTitle.textContent = 'Account';
  } else {
    authButtonAvatar.innerHTML = ICON_USER_OUTLINE;
    authButtonText.textContent = 'Sign In';
    authButton.classList.remove('signed-in');
    authSignedInSection.style.display = 'none';
    authModalTitle.textContent =
      authMode === 'signin' ? 'Sign In' : 'Create Account';
  }
}

/**
 * Sets auth modal mode ('signin' or 'register').
 */
function setAuthMode(mode: 'signin' | 'register'): void {
  authMode = mode;
  authErrorMessage.style.display = 'none';
  if (mode === 'signin') {
    authModalTitle.textContent =
      db.authStatus === AuthStatus.SignedIn ? 'Account' : 'Sign In';
    authTabSignIn.classList.add('active');
    authTabRegister.classList.remove('active');
    submitAuthBtn.textContent = 'Sign In';
  } else {
    authModalTitle.textContent = 'Create Account';
    authTabSignIn.classList.remove('active');
    authTabRegister.classList.add('active');
    submitAuthBtn.textContent = 'Register';
  }
}

/**
 * Updates the sync status badge in the header.
 */
function updateSyncStatusUI(status: SyncStatus): void {
  statusPill.className = `status-pill status-${SyncStatus[status].toLowerCase()}`;
  switch (status) {
    case SyncStatus.Connected:
      statusText.textContent = 'Live Sync';
      break;
    case SyncStatus.Connecting:
      statusText.textContent = 'Connecting...';
      break;
    case SyncStatus.Disconnected:
      statusText.textContent = 'Offline';
      break;
    case SyncStatus.Error:
      statusText.textContent = 'Sync Error';
      break;
  }
}

/**
 * Renders the communities list in the sidebar and select options.
 */
async function renderCommunities(): Promise<void> {
  const currentVersion = ++renderCommunitiesVersion;
  const communities = await communitiesTable.getAllWithMetadata();
  if (currentVersion !== renderCommunitiesVersion) return;

  communities.sort((a, b) => a.data.name.localeCompare(b.data.name));

  communityMap.clear();
  const sidebarFragment = document.createDocumentFragment();
  const selectFragment = document.createDocumentFragment();

  for (const item of communities) {
    const comm = item.data;
    communityMap.set(comm.id, comm);

    // Sidebar item
    const li = document.createElement('li');
    li.className = 'community-row';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `community-item ${activeCommunity === comm.id ? 'active' : ''}`;
    btn.dataset.community = comm.id;
    btn.innerHTML = `
      <span class="community-icon">${escapeHtml(comm.icon)}</span>
      <span class="community-name">${escapeHtml(comm.name)}</span>
    `;
    btn.addEventListener('click', () => selectCommunity(comm.id));
    li.appendChild(btn);

    sidebarFragment.appendChild(li);

    // Option in Create Post dialog
    const opt = document.createElement('option');
    opt.value = comm.id;
    opt.textContent = `${comm.icon} ${comm.name}`;
    selectFragment.appendChild(opt);
  }

  if (currentVersion !== renderCommunitiesVersion) return;

  communityList.replaceChildren(sidebarFragment);
  postCommunitySelect.replaceChildren(selectFragment);

  // Update banner
  if (activeCommunity === 'all') {
    bannerIcon.textContent = '🌐';
    bannerTitle.textContent = 'All Discussions';
    bannerDesc.textContent =
      'All discussions from across the TetherForum network';
  } else {
    const active = communities.find((c) => c.id === activeCommunity);
    if (active) {
      bannerIcon.textContent = active.data.icon;
      bannerTitle.textContent = active.data.name;
      bannerDesc.textContent = active.data.description;
    }
  }

  // Update feed active buttons
  const allFeedBtn = feedList.querySelector<HTMLButtonElement>(
    '[data-community="all"]',
  );
  if (allFeedBtn) {
    if (activeCommunity === 'all') {
      allFeedBtn.classList.add('active');
    } else {
      allFeedBtn.classList.remove('active');
    }
  }
}

/**
 * Selects a community feed to display and switches to feed view.
 */
async function selectCommunity(communityId: string): Promise<void> {
  activeCommunity = communityId;
  closePostDetail();
  await renderCommunities();
  await renderPosts();
}

/**
 * Renders the top-level posts in the feed according to active community and sort mode.
 */
async function renderPosts(): Promise<void> {
  const currentVersion = ++renderPostsVersion;

  let records: StoredRecord<PostItem>[];
  if (activeCommunity === 'all') {
    records = await postsTable.getAllWithMetadata();
  } else {
    records = await communityIndex.getAllWithMetadata(activeCommunity);
  }

  if (currentVersion !== renderPostsVersion) return;

  // Only top-level posts (without parentId) appear in the main feed
  const rootPosts = records.filter((r) => !r.data.parentId);

  const currentUserName = getCurrentUserName();
  const postSummaries = new Map<string, VoteSummary>();
  for (const record of rootPosts) {
    const summary = await getVoteSummary(record.id, currentUserName);
    postSummaries.set(record.id, summary);
  }

  if (currentVersion !== renderPostsVersion) return;

  // Sort posts
  rootPosts.sort((a, b) => {
    const scoreA = postSummaries.get(a.id)?.score ?? 0;
    const scoreB = postSummaries.get(b.id)?.score ?? 0;

    if (currentSort === SortMode.Hot || currentSort === SortMode.Top) {
      if (scoreB !== scoreA) return scoreB - scoreA;
      return b.data.createdAt - a.data.createdAt;
    }
    return b.data.createdAt - a.data.createdAt;
  });

  const fragment = document.createDocumentFragment();

  for (const record of rootPosts) {
    const post = record.data;
    const postId = record.id;
    const author = getAuthorName(record.userName);

    const summary = postSummaries.get(postId) ?? {
      score: 0,
      upvotes: 0,
      downvotes: 0,
      userVote: 0,
    };
    const isUpvoted = summary.userVote === 1;
    const isDownvoted = summary.userVote === -1;
    const score = summary.score;
    const replyCount = await countDescendants(postId);

    if (currentVersion !== renderPostsVersion) return;

    const card = document.createElement('article');
    card.className = 'post-card';
    card.dataset.id = postId;

    // Vote Column
    const voteCol = document.createElement('div');
    voteCol.className = 'vote-column';

    const upvoteBtn = document.createElement('button');
    upvoteBtn.type = 'button';
    upvoteBtn.className = `vote-btn ${isUpvoted ? 'upvoted' : ''}`;
    upvoteBtn.innerHTML = '▲';
    upvoteBtn.title = 'Upvote';
    upvoteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleVote(postId, 'up');
    });

    const scoreSpan = document.createElement('span');
    scoreSpan.className = `vote-score ${score > 0 ? 'positive' : score < 0 ? 'negative' : ''}`;
    scoreSpan.textContent = score.toString();

    const downvoteBtn = document.createElement('button');
    downvoteBtn.type = 'button';
    downvoteBtn.className = `vote-btn ${isDownvoted ? 'downvoted' : ''}`;
    downvoteBtn.innerHTML = '▼';
    downvoteBtn.title = 'Downvote';
    downvoteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleVote(postId, 'down');
    });

    voteCol.appendChild(upvoteBtn);
    voteCol.appendChild(scoreSpan);
    voteCol.appendChild(downvoteBtn);

    // Post Content
    const contentWrap = document.createElement('div');
    contentWrap.className = 'post-content-wrap';

    const meta = document.createElement('div');
    meta.className = 'post-meta';
    meta.innerHTML = `
      <span class="post-community-badge">${escapeHtml(getCommunityName(post.community))}</span>
      <span>•</span>
      <span>Posted by <strong class="post-author">${escapeHtml(author)}</strong></span>
      <span>•</span>
      <span>${formatRelativeTime(post.createdAt)}</span>
    `;

    const title = document.createElement('h3');
    title.className = 'post-title';
    title.textContent = post.title ?? 'Untitled Post';

    const snippet = document.createElement('p');
    snippet.className = 'post-snippet';
    snippet.textContent = post.content;

    const footer = document.createElement('div');
    footer.className = 'post-footer';

    const commentBtn = document.createElement('button');
    commentBtn.type = 'button';
    commentBtn.className = 'post-footer-btn';
    commentBtn.innerHTML = `💬 ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`;
    footer.appendChild(commentBtn);

    // Only post owner can edit or delete (enforced server-side)
    if (isRecordOwner(record)) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'post-footer-btn';
      editBtn.innerHTML = '✏️ Edit';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditPost(postId);
      });
      footer.appendChild(editBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'post-footer-btn post-delete-btn';
      deleteBtn.innerHTML = '🗑️ Delete';
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await handleDeletePost(postId);
      });
      footer.appendChild(deleteBtn);
    }

    contentWrap.appendChild(meta);
    contentWrap.appendChild(title);
    contentWrap.appendChild(snippet);
    contentWrap.appendChild(footer);

    card.appendChild(voteCol);
    card.appendChild(contentWrap);

    card.addEventListener('click', () => openPostDetail(postId));
    fragment.appendChild(card);
  }

  if (currentVersion !== renderPostsVersion) return;

  postFeed.replaceChildren(fragment);
  emptyFeedState.style.display = rootPosts.length === 0 ? 'block' : 'none';
}

/**
 * Handles voting on any post or nested reply.
 */
async function handleVote(
  targetId: string,
  direction: 'up' | 'down',
): Promise<void> {
  if (db.authStatus !== AuthStatus.SignedIn) {
    setAuthMode('signin');
    authModalDialog.showModal();
    return;
  }

  const currentUserName = getCurrentUserName();
  if (!currentUserName) return;

  const targetVote = direction === 'up' ? 1 : -1;
  const summary = await getVoteSummary(targetId, currentUserName);

  if (summary.userVote === targetVote) {
    if (summary.userVoteRecordId) {
      await votesTable.delete(summary.userVoteRecordId);
    }
  } else {
    const voteId =
      summary.userVoteRecordId ?? `vote_${targetId}_${currentUserName}`;
    await votesTable.put(voteId, {
      targetId,
      value: targetVote,
      createdAt: Date.now(),
    });
  }

  scheduleRenderPosts();
  if (activePostId) {
    scheduleRenderReplies();
    updateThreadVoteUI(activePostId);
  }
}

/**
 * Opens the edit dialog for an existing post or reply.
 */
async function openEditPost(postId: string): Promise<void> {
  const record = await postsTable.getWithMetadata(postId);
  if (!record || !isRecordOwner(record)) return;

  const post = record.data;
  editPostIdInput.value = postId;
  editPostContentInput.value = post.content;

  if (post.parentId) {
    if (editPostTitleGroup) editPostTitleGroup.style.display = 'none';
    editPostTitleInput.required = false;
    editPostTitleInput.value = '';
  } else {
    if (editPostTitleGroup) editPostTitleGroup.style.display = 'flex';
    editPostTitleInput.required = true;
    editPostTitleInput.value = post.title ?? '';
  }

  editPostDialog.showModal();
}

/**
 * Recursively deletes a post and all its child replies and votes.
 */
async function handleDeletePost(postId: string): Promise<void> {
  const record = await postsTable.getWithMetadata(postId);
  if (!record || !isRecordOwner(record)) return;

  await deletePostAndDescendants(postId);

  if (activePostId === postId) {
    closePostDetail();
    scheduleRenderPosts();
  } else if (activePostId) {
    scheduleRenderReplies();
  }
}

/**
 * Internal recursive helper to delete a post and all child replies.
 */
async function deletePostAndDescendants(postId: string): Promise<void> {
  // 1. Delete child posts recursively
  const childIds = await parentIndex.getPrimaryKeys(postId);
  for (const childId of childIds) {
    await deletePostAndDescendants(childId);
  }

  // 2. Delete votes for this post
  const voteIds = await targetVotesIndex.getPrimaryKeys(postId);
  if (voteIds.length > 0) {
    await votesTable.deleteAll(voteIds);
  }

  // 3. Delete the post itself
  await postsTable.delete(postId);
}

/**
 * Opens the discussion thread in the main body space.
 */
async function openPostDetail(postId: string): Promise<void> {
  const record = await postsTable.getWithMetadata(postId);
  if (!record) return;

  activePostId = postId;
  const post = record.data;
  const author = getAuthorName(record.userName);

  threadHeaderMeta.innerHTML = `
    <span class="post-community-badge">${escapeHtml(getCommunityName(post.community))}</span>
    <span>•</span>
    <span>Posted by <strong>${escapeHtml(author)}</strong></span>
    <span>•</span>
    <span>${formatRelativeTime(post.createdAt)}</span>
  `;

  if (isRecordOwner(record)) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'post-footer-btn';
    editBtn.innerHTML = '✏️ Edit';
    editBtn.addEventListener('click', () => openEditPost(postId));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'post-footer-btn post-delete-btn';
    deleteBtn.innerHTML = '🗑️ Delete';
    deleteBtn.addEventListener('click', async () => {
      await handleDeletePost(postId);
    });

    threadHeaderMeta.appendChild(editBtn);
    threadHeaderMeta.appendChild(deleteBtn);
  }

  threadPostTitle.textContent = post.title ?? 'Discussion';
  threadPostContent.textContent = post.content;
  updateThreadVoteUI(postId);

  await renderReplies(postId);

  // Switch from Feed View to Thread View
  feedView.style.display = 'none';
  threadView.style.display = 'flex';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * Closes the thread view and returns to the feed view in the main body.
 */
function closePostDetail(): void {
  activePostId = null;
  threadView.style.display = 'none';
  feedView.style.display = 'block';
}

/**
 * Updates the vote column inside the thread view.
 */
async function updateThreadVoteUI(postId: string): Promise<void> {
  const currentUserName = getCurrentUserName();
  const summary = await getVoteSummary(postId, currentUserName);
  const isUpvoted = summary.userVote === 1;
  const isDownvoted = summary.userVote === -1;
  const score = summary.score;

  const fragment = document.createDocumentFragment();

  const upvoteBtn = document.createElement('button');
  upvoteBtn.type = 'button';
  upvoteBtn.className = `vote-btn ${isUpvoted ? 'upvoted' : ''}`;
  upvoteBtn.innerHTML = '▲';
  upvoteBtn.title = 'Upvote';
  upvoteBtn.addEventListener('click', () => handleVote(postId, 'up'));

  const scoreSpan = document.createElement('span');
  scoreSpan.className = `vote-score ${score > 0 ? 'positive' : score < 0 ? 'negative' : ''}`;
  scoreSpan.textContent = score.toString();

  const downvoteBtn = document.createElement('button');
  downvoteBtn.type = 'button';
  downvoteBtn.className = `vote-btn ${isDownvoted ? 'downvoted' : ''}`;
  downvoteBtn.innerHTML = '▼';
  downvoteBtn.title = 'Downvote';
  downvoteBtn.addEventListener('click', () => handleVote(postId, 'down'));

  fragment.appendChild(upvoteBtn);
  fragment.appendChild(scoreSpan);
  fragment.appendChild(downvoteBtn);

  threadVoteColumn.replaceChildren(fragment);
}

/**
 * Renders the nested reply tree for a post in the thread view.
 */
async function renderReplies(rootPostId: string): Promise<void> {
  const currentVersion = ++renderRepliesVersion;
  const totalReplies = await countDescendants(rootPostId);
  if (currentVersion !== renderRepliesVersion) return;

  threadCommentCountBadge.textContent = totalReplies.toString();

  if (totalReplies === 0) {
    commentsList.replaceChildren();
    emptyCommentsState.style.display = 'block';
  } else {
    emptyCommentsState.style.display = 'none';
    const fragment = document.createDocumentFragment();
    await renderReplyTree(rootPostId, fragment, currentVersion);
    if (currentVersion !== renderRepliesVersion) return;
    commentsList.replaceChildren(fragment);
  }
}

/**
 * Recursively renders nested reply nodes into a target container.
 */
async function renderReplyTree(
  parentId: string,
  container: Node,
  version: number,
): Promise<void> {
  const records = await parentIndex.getAllWithMetadata(parentId);
  if (version !== renderRepliesVersion) return;
  records.sort((a, b) => a.data.createdAt - b.data.createdAt);

  const currentUserName = getCurrentUserName();

  for (const record of records) {
    const reply = record.data;
    const replyId = record.id;
    const author = getAuthorName(record.userName);

    const summary = await getVoteSummary(replyId, currentUserName);
    if (version !== renderRepliesVersion) return;

    const isUpvoted = summary.userVote === 1;
    const isDownvoted = summary.userVote === -1;
    const score = summary.score;

    const card = document.createElement('div');
    card.className = 'comment-card';

    // Vote col
    const voteCol = document.createElement('div');
    voteCol.className = 'comment-vote-col';

    const upvoteBtn = document.createElement('button');
    upvoteBtn.type = 'button';
    upvoteBtn.className = `vote-btn ${isUpvoted ? 'upvoted' : ''}`;
    upvoteBtn.innerHTML = '▲';
    upvoteBtn.title = 'Upvote reply';
    upvoteBtn.addEventListener('click', () => handleVote(replyId, 'up'));

    const scoreSpan = document.createElement('span');
    scoreSpan.className = `vote-score ${score > 0 ? 'positive' : score < 0 ? 'negative' : ''}`;
    scoreSpan.textContent = score.toString();

    const downvoteBtn = document.createElement('button');
    downvoteBtn.type = 'button';
    downvoteBtn.className = `vote-btn ${isDownvoted ? 'downvoted' : ''}`;
    downvoteBtn.innerHTML = '▼';
    downvoteBtn.title = 'Downvote reply';
    downvoteBtn.addEventListener('click', () => handleVote(replyId, 'down'));

    voteCol.appendChild(upvoteBtn);
    voteCol.appendChild(scoreSpan);
    voteCol.appendChild(downvoteBtn);

    // Content wrap
    const contentWrap = document.createElement('div');
    contentWrap.className = 'comment-content-wrap';

    const meta = document.createElement('div');
    meta.className = 'comment-meta';
    meta.innerHTML = `
      <span class="comment-author">${escapeHtml(author)}</span>
      <span>•</span>
      <span>${formatRelativeTime(reply.createdAt)}</span>
    `;

    const text = document.createElement('p');
    text.className = 'comment-text';
    text.textContent = reply.content;

    const actions = document.createElement('div');
    actions.className = 'post-footer';

    // Reply button (opens inline composer)
    const replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.className = 'post-footer-btn';
    replyBtn.innerHTML = '↩️ Reply';

    const inlineReplyBox = document.createElement('div');
    inlineReplyBox.className = 'inline-reply-box';
    inlineReplyBox.style.display = 'none';
    inlineReplyBox.innerHTML = `
      <textarea rows="2" placeholder="Write a reply..."></textarea>
      <div class="inline-reply-actions">
        <button type="button" class="btn btn-secondary cancel-reply-btn">Cancel</button>
        <button type="button" class="btn btn-primary submit-reply-btn">Send</button>
      </div>
    `;

    replyBtn.addEventListener('click', () => {
      if (db.authStatus !== AuthStatus.SignedIn) {
        setAuthMode('signin');
        authModalDialog.showModal();
        return;
      }
      inlineReplyBox.style.display =
        inlineReplyBox.style.display === 'none' ? 'flex' : 'none';
    });

    const cancelInlineBtn = inlineReplyBox.querySelector(
      '.cancel-reply-btn',
    ) as HTMLButtonElement;
    cancelInlineBtn.addEventListener('click', () => {
      inlineReplyBox.style.display = 'none';
    });

    const submitInlineBtn = inlineReplyBox.querySelector(
      '.submit-reply-btn',
    ) as HTMLButtonElement;
    const inlineTextarea = inlineReplyBox.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;

    submitInlineBtn.addEventListener('click', async () => {
      if (db.authStatus !== AuthStatus.SignedIn) {
        setAuthMode('signin');
        authModalDialog.showModal();
        return;
      }

      const content = inlineTextarea.value.trim();
      if (!content) return;

      const currentAuthorName = getCurrentUserName();
      const newReplyId = `post_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      await postsTable.put(newReplyId, {
        community: reply.community,
        parentId: replyId,
        content,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Initial author upvote
      if (currentAuthorName) {
        await votesTable.put(`vote_${newReplyId}_${currentAuthorName}`, {
          targetId: newReplyId,
          value: 1,
          createdAt: Date.now(),
        });
      }

      inlineReplyBox.style.display = 'none';
      inlineTextarea.value = '';
    });

    actions.appendChild(replyBtn);

    // Edit and delete for owner (enforced server-side)
    if (isRecordOwner(record)) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'post-footer-btn';
      editBtn.innerHTML = '✏️ Edit';
      editBtn.addEventListener('click', () => openEditPost(replyId));
      actions.appendChild(editBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'post-footer-btn post-delete-btn';
      deleteBtn.innerHTML = '🗑️ Delete';
      deleteBtn.addEventListener('click', async () => {
        await handleDeletePost(replyId);
      });
      actions.appendChild(deleteBtn);
    }

    contentWrap.appendChild(meta);
    contentWrap.appendChild(text);
    contentWrap.appendChild(actions);
    contentWrap.appendChild(inlineReplyBox);

    // Nested child replies container
    const nestedContainer = document.createElement('div');
    nestedContainer.className = 'nested-replies-list';
    await renderReplyTree(replyId, nestedContainer, version);
    if (nestedContainer.children.length > 0) {
      contentWrap.appendChild(nestedContainer);
    }

    card.appendChild(voteCol);
    card.appendChild(contentWrap);
    container.appendChild(card);
  }
}

// -----------------------------------------------------------------------------
// Event Listeners & Actions
// -----------------------------------------------------------------------------

// Auth Modal triggers
authButton.addEventListener('click', () => {
  setAuthMode('signin');
  authForm.reset();
  authModalDialog.showModal();
});

modalSignOutBtn.addEventListener('click', async () => {
  await db.logout();
  authModalDialog.close();
});

closeAuthModalBtn.addEventListener('click', () => {
  authModalDialog.close();
});

cancelAuthModalBtn.addEventListener('click', () => {
  authModalDialog.close();
});

authTabSignIn.addEventListener('click', () => setAuthMode('signin'));
authTabRegister.addEventListener('click', () => setAuthMode('register'));

// Quick sign-in chips
quickUserChips.forEach((chip) => {
  chip.addEventListener('click', async () => {
    const user = chip.dataset.user;
    if (!user) return;
    authUserNameInput.value = user;
    authPasswordInput.value = 'password123';
    submitAuthBtn.click();
  });
});

// Auth form submission
authForm.addEventListener('submit', async (e: SubmitEvent) => {
  e.preventDefault();
  authErrorMessage.style.display = 'none';
  const userName = authUserNameInput.value.trim();
  const password = authPasswordInput.value;
  if (!userName || !password) return;

  try {
    if (authMode === 'signin') {
      await db.login({ userName, password, remember: true });
    } else {
      await db.register({ userName, password, remember: true });
    }
    authModalDialog.close();
    authForm.reset();
  } catch (err) {
    authErrorMessage.textContent =
      err instanceof Error ? err.message : 'Authentication request failed.';
    authErrorMessage.style.display = 'block';
  }
});

// Back to feed button
backToFeedBtn.addEventListener('click', () => {
  closePostDetail();
  scheduleRenderPosts();
});

// Feed switching for all discussions
const allFeedBtn = feedList.querySelector<HTMLButtonElement>(
  '[data-community="all"]',
);
if (allFeedBtn) {
  allFeedBtn.addEventListener('click', () => selectCommunity('all'));
}

// Sort button listeners
sortBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    sortBtns.forEach((b) => {
      b.classList.remove('active');
    });
    btn.classList.add('active');
    currentSort = (btn.dataset.sort as SortMode) ?? SortMode.Hot;
    scheduleRenderPosts();
  });
});

// Create Post dialog triggers
function triggerCreatePost(): void {
  if (db.authStatus !== AuthStatus.SignedIn) {
    setAuthMode('signin');
    authModalDialog.showModal();
    return;
  }
  if (activeCommunity !== 'all') {
    postCommunitySelect.value = activeCommunity;
  }
  createPostForm.reset();
  createPostDialog.showModal();
}

openCreatePostBtn.addEventListener('click', triggerCreatePost);
emptyCreatePostBtn.addEventListener('click', triggerCreatePost);

closeCreatePostModalBtn.addEventListener('click', () => {
  createPostDialog.close();
});

cancelCreatePostBtn.addEventListener('click', () => {
  createPostDialog.close();
});

// Create Post Form Submission
createPostForm.addEventListener('submit', async (e: SubmitEvent) => {
  e.preventDefault();
  if (db.authStatus !== AuthStatus.SignedIn) {
    setAuthMode('signin');
    authModalDialog.showModal();
    return;
  }

  const community = postCommunitySelect.value;
  const title = postTitleInput.value.trim();
  const content = postContentInput.value.trim();
  if (!title || !content || !community) return;

  const currentUserName = getCurrentUserName();
  const postId = `post_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  await postsTable.put(postId, {
    community,
    title,
    content,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  // Automatically cast author's initial upvote
  if (currentUserName) {
    await votesTable.put(`vote_${postId}_${currentUserName}`, {
      targetId: postId,
      value: 1,
      createdAt: Date.now(),
    });
  }

  createPostDialog.close();
  createPostForm.reset();
});

// Edit Post Modal Dialog controls
closeEditPostModalBtn.addEventListener('click', () => {
  editPostDialog.close();
});

cancelEditPostBtn.addEventListener('click', () => {
  editPostDialog.close();
});

// Edit Post Form Submission
editPostForm.addEventListener('submit', async (e: SubmitEvent) => {
  e.preventDefault();
  const postId = editPostIdInput.value;
  const title = editPostTitleInput.value.trim();
  const content = editPostContentInput.value.trim();
  if (!postId || !content) return;

  const record = await postsTable.getWithMetadata(postId);
  if (!record || !isRecordOwner(record)) return;

  const post = record.data;
  await postsTable.put(postId, {
    ...post,
    title: post.parentId ? undefined : title,
    content,
    updatedAt: Date.now(),
  });

  editPostDialog.close();
  editPostForm.reset();

  if (activePostId === postId) {
    if (!post.parentId && title) {
      threadPostTitle.textContent = title;
    }
    threadPostContent.textContent = content;
  }
});

// Top-level reply submission in Thread view
newCommentForm.addEventListener('submit', async (e: SubmitEvent) => {
  e.preventDefault();
  if (!activePostId) return;

  if (db.authStatus !== AuthStatus.SignedIn) {
    setAuthMode('signin');
    authModalDialog.showModal();
    return;
  }

  const content = newCommentInput.value.trim();
  if (!content) return;

  const rootPost = await postsTable.get(activePostId);
  if (!rootPost) return;

  const currentUserName = getCurrentUserName();
  const replyId = `post_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  await postsTable.put(replyId, {
    community: rootPost.community,
    parentId: activePostId,
    content,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  // Automatically cast author's initial upvote on reply
  if (currentUserName) {
    await votesTable.put(`vote_${replyId}_${currentUserName}`, {
      targetId: replyId,
      value: 1,
      createdAt: Date.now(),
    });
  }

  newCommentInput.value = '';
});

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------

/**
 * Initializes the TetherClient, table subscriptions, and initial render.
 */
async function init(): Promise<void> {
  // 1. Subscribe to reactive changes on Posts
  postsTable.onChange.register((events: TableChangeEvent<PostItem>[]) => {
    for (const { op, id, isRemote, data } of events) {
      const origin = isRemote ? 'Remote Sync' : 'Local IDB';
      const label = data?.title ?? (data?.parentId ? `Reply ${id}` : id);
      logMutation(origin, `${op.toUpperCase()} Post "${label}"`);
    }
    scheduleRenderPosts();
    if (activePostId) {
      scheduleRenderReplies();
    }
  });

  // 2. Subscribe to reactive changes on Communities
  communitiesTable.onChange.register(
    (events: TableChangeEvent<CommunityItem>[]) => {
      for (const { op, id, isRemote, data } of events) {
        const origin = isRemote ? 'Remote Sync' : 'Local IDB';
        logMutation(
          origin,
          `${op.toUpperCase()} Community "${data?.name ?? id}"`,
        );
      }
      scheduleRenderCommunities();
    },
  );

  // 3. Subscribe to reactive changes on Votes
  votesTable.onChange.register((events: TableChangeEvent<VoteItem>[]) => {
    for (const { op, id, isRemote } of events) {
      const origin = isRemote ? 'Remote Sync' : 'Local IDB';
      logMutation(origin, `${op.toUpperCase()} Vote ${id}`);
    }
    scheduleRenderPosts();
    if (activePostId) {
      scheduleRenderReplies();
      updateThreadVoteUI(activePostId);
    }
  });

  // 4. React to Auth status changes
  db.onAuthStatusChange.register((status) => {
    updateAuthUI();
    scheduleRenderCommunities();
    scheduleRenderPosts();
    if (activePostId) {
      scheduleRenderReplies();
      updateThreadVoteUI(activePostId);
    }
    logMutation('Auth', `AuthStatus: ${AuthStatus[status]}`);
  });

  // 5. React to Sync status changes
  db.onSyncStatusChange.register((status) => {
    updateSyncStatusUI(status);
    logMutation('Sync', `SyncStatus: ${SyncStatus[status]}`);
  });

  // 6. Initial render
  updateAuthUI();
  updateSyncStatusUI(db.syncStatus);
  await renderCommunities();
  await renderPosts();
}

init();
