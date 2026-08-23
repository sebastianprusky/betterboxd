-- Allow signed-in users to remove their own synchronized PickAMovie activity.
grant delete on public.user_app_state to authenticated;

drop policy if exists "Users can delete their own app state" on public.user_app_state;
create policy "Users can delete their own app state"
  on public.user_app_state
  for delete
  to authenticated
  using (auth.uid() = user_id);
