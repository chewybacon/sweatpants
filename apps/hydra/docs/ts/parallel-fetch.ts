// parallel-fetch.ts
import type { Operation, Task } from 'effection';
import { main, spawn, sleep } from 'effection';

interface User {
  id: number;
  name: string;
}

interface Post {
  id: number;
  title: string;
}

interface Comment {
  id: number;
  text: string;
}

// Simulated API calls
function* fetchUser(id: number): Operation<User> {
  yield* sleep(300);
  return { id, name: `User ${id}` };
}

function* fetchPosts(userId: number): Operation<Post[]> {
  yield* sleep(500);
  return [
    { id: 1, title: 'First Post' },
    { id: 2, title: 'Second Post' },
  ];
}

function* fetchComments(postId: number): Operation<Comment[]> {
  yield* sleep(200);
  return [{ id: 1, text: 'Great post!' }];
}

await main(function*() {
  console.time('total');
  
  // Fetch user first
  const user: User = yield* fetchUser(1);
  
  // Then fetch posts and comments in parallel
  const postsTask: Task<Post[]> = yield* spawn(() => fetchPosts(user.id));
  const commentsTask: Task<Comment[]> = yield* spawn(() => fetchComments(1));
  
  const posts: Post[] = yield* postsTask;
  const comments: Comment[] = yield* commentsTask;
  
  console.log({ user, posts, comments });
  console.timeEnd('total'); // ~800ms, not 1000ms!
});
