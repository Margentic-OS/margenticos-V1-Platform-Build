export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_runs: {
        Row: {
          agent_name: string
          completed_at: string | null
          duration_ms: number | null
          error_message: string | null
          id: string
          organisation_id: string
          output_summary: string | null
          started_at: string
          status: string
        }
        Insert: {
          agent_name: string
          completed_at?: string | null
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          organisation_id: string
          output_summary?: string | null
          started_at?: string
          status: string
        }
        Update: {
          agent_name?: string
          completed_at?: string | null
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          organisation_id?: string
          output_summary?: string | null
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_runs_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          bounced_count: number
          campaign_stats_updated_at: string | null
          campaign_type: string
          contacted_count: number
          created_at: string
          external_id: string | null
          id: string
          name: string | null
          open_count: number
          organisation_id: string
          paused_at: string | null
          replied_count: number
          sending_state: string | null
          sending_status_checked_at: string | null
          sending_status_raw: string | null
          sent_count: number
          sequence_name: string | null
          shell_delays: Json | null
          shell_doc_id: string | null
          shell_segment_id: string | null
          shell_step_count: number | null
          shell_synced_at: string | null
          started_at: string | null
          status: string
          unsubscribed_count: number
          updated_at: string
        }
        Insert: {
          bounced_count?: number
          campaign_stats_updated_at?: string | null
          campaign_type: string
          contacted_count?: number
          created_at?: string
          external_id?: string | null
          id?: string
          name?: string | null
          open_count?: number
          organisation_id: string
          paused_at?: string | null
          replied_count?: number
          sending_state?: string | null
          sending_status_checked_at?: string | null
          sending_status_raw?: string | null
          sent_count?: number
          sequence_name?: string | null
          shell_delays?: Json | null
          shell_doc_id?: string | null
          shell_segment_id?: string | null
          shell_step_count?: number | null
          shell_synced_at?: string | null
          started_at?: string | null
          status?: string
          unsubscribed_count?: number
          updated_at?: string
        }
        Update: {
          bounced_count?: number
          campaign_stats_updated_at?: string | null
          campaign_type?: string
          contacted_count?: number
          created_at?: string
          external_id?: string | null
          id?: string
          name?: string | null
          open_count?: number
          organisation_id?: string
          paused_at?: string | null
          replied_count?: number
          sending_state?: string | null
          sending_status_checked_at?: string | null
          sending_status_raw?: string | null
          sent_count?: number
          sequence_name?: string | null
          shell_delays?: Json | null
          shell_doc_id?: string | null
          shell_segment_id?: string | null
          shell_step_count?: number | null
          shell_synced_at?: string | null
          started_at?: string | null
          status?: string
          unsubscribed_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      cron_heartbeats: {
        Row: {
          created_at: string
          detail: string | null
          id: number
          job_name: string
          ok: boolean
          ran_at: string
        }
        Insert: {
          created_at?: string
          detail?: string | null
          id?: number
          job_name: string
          ok?: boolean
          ran_at?: string
        }
        Update: {
          created_at?: string
          detail?: string | null
          id?: number
          job_name?: string
          ok?: boolean
          ran_at?: string
        }
        Relationships: []
      }
      cron_schedule_registry: {
        Row: {
          declared_by: string
          jobname: string
          notes: string | null
          schedule: string
          updated_at: string
        }
        Insert: {
          declared_by: string
          jobname: string
          notes?: string | null
          schedule: string
          updated_at?: string
        }
        Update: {
          declared_by?: string
          jobname?: string
          notes?: string | null
          schedule?: string
          updated_at?: string
        }
        Relationships: []
      }
      document_suggestions: {
        Row: {
          ab_variant: string | null
          confidence_level: string
          conflicting_suggestion_id: string | null
          created_at: string
          current_value: string | null
          document_id: string | null
          document_type: string
          field_path: string
          id: string
          organisation_id: string
          rejection_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          revision_note: string | null
          segment_id: string | null
          sequence_position: number | null
          signal_count: number
          status: string
          suggested_value: string
          suggestion_reason: string | null
          update_trigger: string
        }
        Insert: {
          ab_variant?: string | null
          confidence_level?: string
          conflicting_suggestion_id?: string | null
          created_at?: string
          current_value?: string | null
          document_id?: string | null
          document_type: string
          field_path: string
          id?: string
          organisation_id: string
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          revision_note?: string | null
          segment_id?: string | null
          sequence_position?: number | null
          signal_count?: number
          status?: string
          suggested_value: string
          suggestion_reason?: string | null
          update_trigger?: string
        }
        Update: {
          ab_variant?: string | null
          confidence_level?: string
          conflicting_suggestion_id?: string | null
          created_at?: string
          current_value?: string | null
          document_id?: string | null
          document_type?: string
          field_path?: string
          id?: string
          organisation_id?: string
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          revision_note?: string | null
          segment_id?: string | null
          sequence_position?: number | null
          signal_count?: number
          status?: string
          suggested_value?: string
          suggestion_reason?: string | null
          update_trigger?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_suggestions_conflicting_suggestion_id_fkey"
            columns: ["conflicting_suggestion_id"]
            isOneToOne: false
            referencedRelation: "document_suggestions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_suggestions_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "strategy_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_suggestions_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_suggestions_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_suggestions_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_suggestions_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
        ]
      }
      enrichment_runs: {
        Row: {
          batch_size: number
          created_at: string | null
          credits_consumed: number
          error_message: string | null
          id: string
          missing_records: number
          organisation_id: string
          run_timestamp: string
          status: string
          total_requested_enrichments: number
          unique_enriched_records: number
          updated_at: string | null
        }
        Insert: {
          batch_size: number
          created_at?: string | null
          credits_consumed: number
          error_message?: string | null
          id?: string
          missing_records: number
          organisation_id: string
          run_timestamp: string
          status: string
          total_requested_enrichments: number
          unique_enriched_records: number
          updated_at?: string | null
        }
        Update: {
          batch_size?: number
          created_at?: string | null
          credits_consumed?: number
          error_message?: string | null
          id?: string
          missing_records?: number
          organisation_id?: string
          run_timestamp?: string
          status?: string
          total_requested_enrichments?: number
          unique_enriched_records?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "enrichment_runs_organisation_fk"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enrichment_runs_organisation_fk"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      faq_extractions: {
        Row: {
          created_at: string
          extracted_question: string
          id: string
          organisation_id: string
          potential_names_flagged: Json
          prompt_version: string | null
          reply_draft_id: string | null
          reviewed_at: string | null
          reviewed_by_user_id: string | null
          signal_id: string | null
          similar_faq_id: string | null
          similar_pending_extraction_id: string | null
          similarity_score: number | null
          source: string
          status: string
          suggested_answer: string
        }
        Insert: {
          created_at?: string
          extracted_question: string
          id?: string
          organisation_id: string
          potential_names_flagged?: Json
          prompt_version?: string | null
          reply_draft_id?: string | null
          reviewed_at?: string | null
          reviewed_by_user_id?: string | null
          signal_id?: string | null
          similar_faq_id?: string | null
          similar_pending_extraction_id?: string | null
          similarity_score?: number | null
          source?: string
          status?: string
          suggested_answer: string
        }
        Update: {
          created_at?: string
          extracted_question?: string
          id?: string
          organisation_id?: string
          potential_names_flagged?: Json
          prompt_version?: string | null
          reply_draft_id?: string | null
          reviewed_at?: string | null
          reviewed_by_user_id?: string | null
          signal_id?: string | null
          similar_faq_id?: string | null
          similar_pending_extraction_id?: string | null
          similarity_score?: number | null
          source?: string
          status?: string
          suggested_answer?: string
        }
        Relationships: [
          {
            foreignKeyName: "faq_extractions_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "faq_extractions_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "faq_extractions_reply_draft_id_fkey"
            columns: ["reply_draft_id"]
            isOneToOne: false
            referencedRelation: "reply_drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "faq_extractions_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "faq_extractions_similar_faq_id_fkey"
            columns: ["similar_faq_id"]
            isOneToOne: false
            referencedRelation: "faqs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "faq_extractions_similar_pending_extraction_id_fkey"
            columns: ["similar_pending_extraction_id"]
            isOneToOne: false
            referencedRelation: "faq_extractions"
            referencedColumns: ["id"]
          },
        ]
      }
      faqs: {
        Row: {
          answer: string
          created_at: string
          created_by_user_id: string | null
          id: string
          last_used_at: string | null
          organisation_id: string
          question_canonical: string
          question_variants: Json
          source_signal_ids: Json
          status: string
          times_used: number
          updated_at: string
        }
        Insert: {
          answer: string
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          last_used_at?: string | null
          organisation_id: string
          question_canonical: string
          question_variants?: Json
          source_signal_ids?: Json
          status?: string
          times_used?: number
          updated_at?: string
        }
        Update: {
          answer?: string
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          last_used_at?: string | null
          organisation_id?: string
          question_canonical?: string
          question_variants?: Json
          source_signal_ids?: Json
          status?: string
          times_used?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "faqs_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "faqs_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      industry_tag_mappings: {
        Row: {
          apollo_tag: string
          canonical_industry: string
          created_at: string
          created_by: string
          updated_at: string
        }
        Insert: {
          apollo_tag: string
          canonical_industry: string
          created_at?: string
          created_by: string
          updated_at?: string
        }
        Update: {
          apollo_tag?: string
          canonical_industry?: string
          created_at?: string
          created_by?: string
          updated_at?: string
        }
        Relationships: []
      }
      intake_files: {
        Row: {
          created_at: string
          created_by: string | null
          extracted_text: string | null
          extraction_status: string
          file_purpose: string
          file_size_bytes: number
          id: string
          mime_type: string
          organisation_id: string
          original_filename: string
          storage_path: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          extracted_text?: string | null
          extraction_status?: string
          file_purpose: string
          file_size_bytes: number
          id?: string
          mime_type: string
          organisation_id: string
          original_filename: string
          storage_path: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          extracted_text?: string | null
          extraction_status?: string
          file_purpose?: string
          file_size_bytes?: number
          id?: string
          mime_type?: string
          organisation_id?: string
          original_filename?: string
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "intake_files_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intake_files_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intake_files_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      intake_responses: {
        Row: {
          field_key: string
          field_label: string
          id: string
          is_critical: boolean
          organisation_id: string
          response_value: string | null
          section: string
          segment_id: string | null
          updated_at: string
          version: number
          word_count: number
        }
        Insert: {
          field_key: string
          field_label: string
          id?: string
          is_critical?: boolean
          organisation_id: string
          response_value?: string | null
          section: string
          segment_id?: string | null
          updated_at?: string
          version?: number
          word_count?: number
        }
        Update: {
          field_key?: string
          field_label?: string
          id?: string
          is_critical?: boolean
          organisation_id?: string
          response_value?: string | null
          section?: string
          segment_id?: string | null
          updated_at?: string
          version?: number
          word_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "intake_responses_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intake_responses_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intake_responses_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
        ]
      }
      intake_website_pages: {
        Row: {
          created_at: string
          display_order: number
          error_message: string | null
          extracted_text: string | null
          extraction_truncated: boolean
          fetch_status: string
          fetched_at: string | null
          id: string
          organisation_id: string
          page_label: string
          url: string
        }
        Insert: {
          created_at?: string
          display_order?: number
          error_message?: string | null
          extracted_text?: string | null
          extraction_truncated?: boolean
          fetch_status?: string
          fetched_at?: string | null
          id?: string
          organisation_id: string
          page_label: string
          url: string
        }
        Update: {
          created_at?: string
          display_order?: number
          error_message?: string | null
          extracted_text?: string | null
          extraction_truncated?: boolean
          fetch_status?: string
          fetched_at?: string | null
          id?: string
          organisation_id?: string
          page_label?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "intake_website_pages_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intake_website_pages_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_credentials: {
        Row: {
          created_at: string
          credential_type: string
          id: string
          organisation_id: string | null
          source: string
          updated_at: string
          value: string
        }
        Insert: {
          created_at?: string
          credential_type: string
          id?: string
          organisation_id?: string | null
          source: string
          updated_at?: string
          value: string
        }
        Update: {
          created_at?: string
          credential_type?: string
          id?: string
          organisation_id?: string | null
          source?: string
          updated_at?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "integration_credentials_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "integration_credentials_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      integrations_registry: {
        Row: {
          api_handler_ref: string
          capability: string
          config: Json
          connection_status: string
          created_at: string
          id: string
          is_active: boolean
          supported_fields: string[] | null
          tool_name: string
          updated_at: string
        }
        Insert: {
          api_handler_ref: string
          capability: string
          config?: Json
          connection_status?: string
          created_at?: string
          id?: string
          is_active?: boolean
          supported_fields?: string[] | null
          tool_name: string
          updated_at?: string
        }
        Update: {
          api_handler_ref?: string
          capability?: string
          config?: Json
          connection_status?: string
          created_at?: string
          id?: string
          is_active?: boolean
          supported_fields?: string[] | null
          tool_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      job_queue: {
        Row: {
          attempts: number
          claimed_by: string | null
          created_at: string
          enqueued_by: string | null
          id: string
          job_type: string
          last_error: string | null
          last_error_class: string | null
          lease_expires_at: string | null
          max_attempts: number
          organisation_id: string
          prospect_id: string
          result_summary: string | null
          run_after: string
          spend_detail: Json | null
          spend_recorded_at: string | null
          state: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          claimed_by?: string | null
          created_at?: string
          enqueued_by?: string | null
          id?: string
          job_type: string
          last_error?: string | null
          last_error_class?: string | null
          lease_expires_at?: string | null
          max_attempts?: number
          organisation_id: string
          prospect_id: string
          result_summary?: string | null
          run_after?: string
          spend_detail?: Json | null
          spend_recorded_at?: string | null
          state?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          claimed_by?: string | null
          created_at?: string
          enqueued_by?: string | null
          id?: string
          job_type?: string
          last_error?: string | null
          last_error_class?: string | null
          lease_expires_at?: string | null
          max_attempts?: number
          organisation_id?: string
          prospect_id?: string
          result_summary?: string | null
          run_after?: string
          spend_detail?: Json | null
          spend_recorded_at?: string | null
          state?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_queue_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_queue_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_queue_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "client_prospects_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_queue_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "prospects"
            referencedColumns: ["id"]
          },
        ]
      }
      meetings: {
        Row: {
          billed_at: string | null
          booked_at: string
          calendly_event_uuid: string | null
          calendly_invitee_uuid: string | null
          campaign_id: string | null
          created_at: string
          held_confirmed_by: string | null
          held_decision_locked: boolean
          id: string
          invitee_phone: string | null
          is_billable: boolean
          meeting_date: string | null
          meeting_status: string
          organisation_id: string
          prospect_id: string | null
          qualification: string | null
          qualification_notes: string | null
          revenue_value: number | null
          scheduled_start_at: string | null
          source: string
          status: string
          updated_at: string
        }
        Insert: {
          billed_at?: string | null
          booked_at?: string
          calendly_event_uuid?: string | null
          calendly_invitee_uuid?: string | null
          campaign_id?: string | null
          created_at?: string
          held_confirmed_by?: string | null
          held_decision_locked?: boolean
          id?: string
          invitee_phone?: string | null
          is_billable?: boolean
          meeting_date?: string | null
          meeting_status?: string
          organisation_id: string
          prospect_id?: string | null
          qualification?: string | null
          qualification_notes?: string | null
          revenue_value?: number | null
          scheduled_start_at?: string | null
          source?: string
          status?: string
          updated_at?: string
        }
        Update: {
          billed_at?: string | null
          booked_at?: string
          calendly_event_uuid?: string | null
          calendly_invitee_uuid?: string | null
          campaign_id?: string | null
          created_at?: string
          held_confirmed_by?: string | null
          held_decision_locked?: boolean
          id?: string
          invitee_phone?: string | null
          is_billable?: boolean
          meeting_date?: string | null
          meeting_status?: string
          organisation_id?: string
          prospect_id?: string | null
          qualification?: string | null
          qualification_notes?: string | null
          revenue_value?: number | null
          scheduled_start_at?: string | null
          source?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meetings_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "client_prospects_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "prospects"
            referencedColumns: ["id"]
          },
        ]
      }
      monitor_checks: {
        Row: {
          category: string
          code: string
          created_at: string
          description: string
          expected_interval_minutes: number | null
          is_scheduled: boolean
          plain_action: string
          plain_impact: string
          plain_meaning: string
          tier: number
          title: string
        }
        Insert: {
          category: string
          code: string
          created_at?: string
          description: string
          expected_interval_minutes?: number | null
          is_scheduled?: boolean
          plain_action?: string
          plain_impact?: string
          plain_meaning?: string
          tier: number
          title: string
        }
        Update: {
          category?: string
          code?: string
          created_at?: string
          description?: string
          expected_interval_minutes?: number | null
          is_scheduled?: boolean
          plain_action?: string
          plain_impact?: string
          plain_meaning?: string
          tier?: number
          title?: string
        }
        Relationships: []
      }
      monitor_events: {
        Row: {
          acknowledged_at: string | null
          acknowledged_note: string | null
          check_code: string
          created_at: string
          detail: string | null
          id: number
          resolved_at: string | null
          state: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_note?: string | null
          check_code: string
          created_at?: string
          detail?: string | null
          id?: number
          resolved_at?: string | null
          state: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_note?: string | null
          check_code?: string
          created_at?: string
          detail?: string | null
          id?: number
          resolved_at?: string | null
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "monitor_events_check_code_fkey"
            columns: ["check_code"]
            isOneToOne: false
            referencedRelation: "monitor_checks"
            referencedColumns: ["code"]
          },
        ]
      }
      notifications_log: {
        Row: {
          id: string
          notification_type: string
          organisation_id: string
          sent_at: string | null
          subject_id: string
        }
        Insert: {
          id?: string
          notification_type: string
          organisation_id: string
          sent_at?: string | null
          subject_id: string
        }
        Update: {
          id?: string
          notification_type?: string
          organisation_id?: string
          sent_at?: string | null
          subject_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_log_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_log_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      organisations: {
        Row: {
          agents_dispatched_at: string | null
          archived_at: string | null
          auto_approve_window_hours: number
          auto_held_window_hours: number
          billing_basis: string
          calendly_url: string | null
          calendly_webhook_secret: string | null
          client_review_enabled: boolean
          contract_end_date: string | null
          contract_start_date: string | null
          contract_status: string | null
          created_at: string
          currency: string
          docs_complete_notification_sent_at: string | null
          engagement_month: number
          founder_first_name: string | null
          founder_last_name: string | null
          founder_title: string | null
          id: string
          intake_last_activity_at: string | null
          linkedin_channel_enabled: boolean
          meetings_count: number
          monthly_meetings_target: number
          name: string
          payment_status: string | null
          pipeline_unlock_at: string | null
          pipeline_unlock_manual_override: boolean
          pipeline_unlocked: boolean
          reminder_handling: string | null
          setup_status: Json
          slug: string
          updated_at: string
          warmup_completed_at: string | null
          warmup_started_at: string | null
        }
        Insert: {
          agents_dispatched_at?: string | null
          archived_at?: string | null
          auto_approve_window_hours?: number
          auto_held_window_hours?: number
          billing_basis?: string
          calendly_url?: string | null
          calendly_webhook_secret?: string | null
          client_review_enabled?: boolean
          contract_end_date?: string | null
          contract_start_date?: string | null
          contract_status?: string | null
          created_at?: string
          currency?: string
          docs_complete_notification_sent_at?: string | null
          engagement_month?: number
          founder_first_name?: string | null
          founder_last_name?: string | null
          founder_title?: string | null
          id?: string
          intake_last_activity_at?: string | null
          linkedin_channel_enabled?: boolean
          meetings_count?: number
          monthly_meetings_target?: number
          name: string
          payment_status?: string | null
          pipeline_unlock_at?: string | null
          pipeline_unlock_manual_override?: boolean
          pipeline_unlocked?: boolean
          reminder_handling?: string | null
          setup_status?: Json
          slug: string
          updated_at?: string
          warmup_completed_at?: string | null
          warmup_started_at?: string | null
        }
        Update: {
          agents_dispatched_at?: string | null
          archived_at?: string | null
          auto_approve_window_hours?: number
          auto_held_window_hours?: number
          billing_basis?: string
          calendly_url?: string | null
          calendly_webhook_secret?: string | null
          client_review_enabled?: boolean
          contract_end_date?: string | null
          contract_start_date?: string | null
          contract_status?: string | null
          created_at?: string
          currency?: string
          docs_complete_notification_sent_at?: string | null
          engagement_month?: number
          founder_first_name?: string | null
          founder_last_name?: string | null
          founder_title?: string | null
          id?: string
          intake_last_activity_at?: string | null
          linkedin_channel_enabled?: boolean
          meetings_count?: number
          monthly_meetings_target?: number
          name?: string
          payment_status?: string | null
          pipeline_unlock_at?: string | null
          pipeline_unlock_manual_override?: boolean
          pipeline_unlocked?: boolean
          reminder_handling?: string | null
          setup_status?: Json
          slug?: string
          updated_at?: string
          warmup_completed_at?: string | null
          warmup_started_at?: string | null
        }
        Relationships: []
      }
      patterns: {
        Row: {
          confidence_score: number | null
          created_at: string
          id: string
          pattern_data: Json
          pattern_type: string
          sample_size: number
          updated_at: string
        }
        Insert: {
          confidence_score?: number | null
          created_at?: string
          id?: string
          pattern_data?: Json
          pattern_type: string
          sample_size?: number
          updated_at?: string
        }
        Update: {
          confidence_score?: number | null
          created_at?: string
          id?: string
          pattern_data?: Json
          pattern_type?: string
          sample_size?: number
          updated_at?: string
        }
        Relationships: []
      }
      polling_cursors: {
        Row: {
          created_at: string
          error_count: number
          id: string
          last_cursor: string | null
          last_error: string | null
          last_polled_at: string | null
          last_run_at: string | null
          organisation_id: string | null
          resource: string
          source: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          error_count?: number
          id?: string
          last_cursor?: string | null
          last_error?: string | null
          last_polled_at?: string | null
          last_run_at?: string | null
          organisation_id?: string | null
          resource: string
          source: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          error_count?: number
          id?: string
          last_cursor?: string | null
          last_error?: string | null
          last_polled_at?: string | null
          last_run_at?: string | null
          organisation_id?: string | null
          resource?: string
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "polling_cursors_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "polling_cursors_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      prospect_research_results: {
        Row: {
          candidates: Json
          created_at: string
          has_dateable_signal: boolean
          icp_fit: string
          id: string
          organisation_id: string
          prospect_id: string
          qualification_reason: string | null
          qualification_status: string
          raw_apollo: Json | null
          raw_linkedin: Json | null
          raw_web_search: Json | null
          raw_website: Json | null
          relevance_reason: string | null
          run_id: string | null
          selected_candidate_id: string | null
          signal_observation: string | null
          signal_relevance: string
          sources_attempted: string[]
          sources_successful: string[]
          synthesis_confidence: string | null
          synthesis_reasoning: string | null
          synthesized_at: string
          trigger_source: Json | null
          trigger_text: string | null
        }
        Insert: {
          candidates?: Json
          created_at?: string
          has_dateable_signal?: boolean
          icp_fit?: string
          id?: string
          organisation_id: string
          prospect_id: string
          qualification_reason?: string | null
          qualification_status?: string
          raw_apollo?: Json | null
          raw_linkedin?: Json | null
          raw_web_search?: Json | null
          raw_website?: Json | null
          relevance_reason?: string | null
          run_id?: string | null
          selected_candidate_id?: string | null
          signal_observation?: string | null
          signal_relevance?: string
          sources_attempted?: string[]
          sources_successful?: string[]
          synthesis_confidence?: string | null
          synthesis_reasoning?: string | null
          synthesized_at?: string
          trigger_source?: Json | null
          trigger_text?: string | null
        }
        Update: {
          candidates?: Json
          created_at?: string
          has_dateable_signal?: boolean
          icp_fit?: string
          id?: string
          organisation_id?: string
          prospect_id?: string
          qualification_reason?: string | null
          qualification_status?: string
          raw_apollo?: Json | null
          raw_linkedin?: Json | null
          raw_web_search?: Json | null
          raw_website?: Json | null
          relevance_reason?: string | null
          run_id?: string | null
          selected_candidate_id?: string | null
          signal_observation?: string | null
          signal_relevance?: string
          sources_attempted?: string[]
          sources_successful?: string[]
          synthesis_confidence?: string | null
          synthesis_reasoning?: string | null
          synthesized_at?: string
          trigger_source?: Json | null
          trigger_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "prospect_research_results_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prospect_research_results_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prospect_research_results_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "client_prospects_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prospect_research_results_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "prospects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prospect_research_results_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      prospects: {
        Row: {
          apollo_enrichment_data: Json | null
          campaign_id: string | null
          classified_at: string | null
          client_review_auto_approved_at: string | null
          client_review_reason: string | null
          client_review_status: string | null
          company_headcount: number | null
          company_industry: string | null
          company_name: string | null
          country: string | null
          created_at: string
          current_research_result_id: string | null
          email: string | null
          email_send_eligible: boolean | null
          email_send_ineligible_reason: string | null
          email_status: string | null
          enrichment_credit_consumed_at: string | null
          enrichment_locked_at: string | null
          enrichment_mode: string | null
          enrichment_run_id: string | null
          enrichment_status: string | null
          first_name: string | null
          fit_score: number | null
          has_dateable_signal: boolean
          icp_fit: string
          id: string
          independent_email_status: string | null
          independent_verified_at: string | null
          job_title: string | null
          last_name: string | null
          last_verification_error: string | null
          linkedin_url: string | null
          linkedin_url_normalised: string | null
          messaging_doc_id: string | null
          operator_override_at: string | null
          operator_override_by: string | null
          operator_override_reason: string | null
          operator_override_tier: string | null
          organisation_id: string
          outbound_lead_id: string | null
          outbound_suppression_at: string | null
          outbound_suppression_error: string | null
          outbound_suppression_status: string | null
          outbound_upload_attempted_at: string | null
          outbound_upload_error: string | null
          outbound_upload_status: string
          personalisation_question: string | null
          personalisation_subject: string | null
          personalisation_trigger: string | null
          qualification_status: string | null
          qualified_at: string | null
          research_ran_at: string | null
          research_source: string | null
          role: string | null
          second_pass_accept_all: boolean | null
          second_pass_attempt_count: number
          second_pass_error: string | null
          second_pass_locked_at: string | null
          second_pass_provider: string | null
          second_pass_reason: string | null
          second_pass_score: number | null
          second_pass_status: string | null
          second_pass_verified_at: string | null
          segment_id: string | null
          signal_observation: string | null
          signal_relevance: string
          source_person_key: string | null
          sourced_tier: string | null
          sourcing_review_status: string | null
          sourcing_run_id: string | null
          suppressed: boolean
          suppressed_at: string | null
          suppression_reason: string | null
          tier_published_at: string | null
          tiering_reason: string | null
          trigger_confidence: string | null
          trigger_data: Json | null
          updated_at: string
          variant_id: string | null
          verification_attempt_count: number | null
          verification_locked_at: string | null
          verification_provider: string | null
          website_url: string | null
        }
        Insert: {
          apollo_enrichment_data?: Json | null
          campaign_id?: string | null
          classified_at?: string | null
          client_review_auto_approved_at?: string | null
          client_review_reason?: string | null
          client_review_status?: string | null
          company_headcount?: number | null
          company_industry?: string | null
          company_name?: string | null
          country?: string | null
          created_at?: string
          current_research_result_id?: string | null
          email?: string | null
          email_send_eligible?: boolean | null
          email_send_ineligible_reason?: string | null
          email_status?: string | null
          enrichment_credit_consumed_at?: string | null
          enrichment_locked_at?: string | null
          enrichment_mode?: string | null
          enrichment_run_id?: string | null
          enrichment_status?: string | null
          first_name?: string | null
          fit_score?: number | null
          has_dateable_signal?: boolean
          icp_fit?: string
          id?: string
          independent_email_status?: string | null
          independent_verified_at?: string | null
          job_title?: string | null
          last_name?: string | null
          last_verification_error?: string | null
          linkedin_url?: string | null
          linkedin_url_normalised?: string | null
          messaging_doc_id?: string | null
          operator_override_at?: string | null
          operator_override_by?: string | null
          operator_override_reason?: string | null
          operator_override_tier?: string | null
          organisation_id: string
          outbound_lead_id?: string | null
          outbound_suppression_at?: string | null
          outbound_suppression_error?: string | null
          outbound_suppression_status?: string | null
          outbound_upload_attempted_at?: string | null
          outbound_upload_error?: string | null
          outbound_upload_status?: string
          personalisation_question?: string | null
          personalisation_subject?: string | null
          personalisation_trigger?: string | null
          qualification_status?: string | null
          qualified_at?: string | null
          research_ran_at?: string | null
          research_source?: string | null
          role?: string | null
          second_pass_accept_all?: boolean | null
          second_pass_attempt_count?: number
          second_pass_error?: string | null
          second_pass_locked_at?: string | null
          second_pass_provider?: string | null
          second_pass_reason?: string | null
          second_pass_score?: number | null
          second_pass_status?: string | null
          second_pass_verified_at?: string | null
          segment_id?: string | null
          signal_observation?: string | null
          signal_relevance?: string
          source_person_key?: string | null
          sourced_tier?: string | null
          sourcing_review_status?: string | null
          sourcing_run_id?: string | null
          suppressed?: boolean
          suppressed_at?: string | null
          suppression_reason?: string | null
          tier_published_at?: string | null
          tiering_reason?: string | null
          trigger_confidence?: string | null
          trigger_data?: Json | null
          updated_at?: string
          variant_id?: string | null
          verification_attempt_count?: number | null
          verification_locked_at?: string | null
          verification_provider?: string | null
          website_url?: string | null
        }
        Update: {
          apollo_enrichment_data?: Json | null
          campaign_id?: string | null
          classified_at?: string | null
          client_review_auto_approved_at?: string | null
          client_review_reason?: string | null
          client_review_status?: string | null
          company_headcount?: number | null
          company_industry?: string | null
          company_name?: string | null
          country?: string | null
          created_at?: string
          current_research_result_id?: string | null
          email?: string | null
          email_send_eligible?: boolean | null
          email_send_ineligible_reason?: string | null
          email_status?: string | null
          enrichment_credit_consumed_at?: string | null
          enrichment_locked_at?: string | null
          enrichment_mode?: string | null
          enrichment_run_id?: string | null
          enrichment_status?: string | null
          first_name?: string | null
          fit_score?: number | null
          has_dateable_signal?: boolean
          icp_fit?: string
          id?: string
          independent_email_status?: string | null
          independent_verified_at?: string | null
          job_title?: string | null
          last_name?: string | null
          last_verification_error?: string | null
          linkedin_url?: string | null
          linkedin_url_normalised?: string | null
          messaging_doc_id?: string | null
          operator_override_at?: string | null
          operator_override_by?: string | null
          operator_override_reason?: string | null
          operator_override_tier?: string | null
          organisation_id?: string
          outbound_lead_id?: string | null
          outbound_suppression_at?: string | null
          outbound_suppression_error?: string | null
          outbound_suppression_status?: string | null
          outbound_upload_attempted_at?: string | null
          outbound_upload_error?: string | null
          outbound_upload_status?: string
          personalisation_question?: string | null
          personalisation_subject?: string | null
          personalisation_trigger?: string | null
          qualification_status?: string | null
          qualified_at?: string | null
          research_ran_at?: string | null
          research_source?: string | null
          role?: string | null
          second_pass_accept_all?: boolean | null
          second_pass_attempt_count?: number
          second_pass_error?: string | null
          second_pass_locked_at?: string | null
          second_pass_provider?: string | null
          second_pass_reason?: string | null
          second_pass_score?: number | null
          second_pass_status?: string | null
          second_pass_verified_at?: string | null
          segment_id?: string | null
          signal_observation?: string | null
          signal_relevance?: string
          source_person_key?: string | null
          sourced_tier?: string | null
          sourcing_review_status?: string | null
          sourcing_run_id?: string | null
          suppressed?: boolean
          suppressed_at?: string | null
          suppression_reason?: string | null
          tier_published_at?: string | null
          tiering_reason?: string | null
          trigger_confidence?: string | null
          trigger_data?: Json | null
          updated_at?: string
          variant_id?: string | null
          verification_attempt_count?: number | null
          verification_locked_at?: string | null
          verification_provider?: string | null
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "prospects_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prospects_current_research_result_id_fkey"
            columns: ["current_research_result_id"]
            isOneToOne: false
            referencedRelation: "prospect_research_results"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prospects_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prospects_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prospects_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prospects_sourcing_run_id_fkey"
            columns: ["sourcing_run_id"]
            isOneToOne: false
            referencedRelation: "sourcing_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      queue_rotation: {
        Row: {
          job_type: string
          last_organisation_id: string | null
          updated_at: string
        }
        Insert: {
          job_type: string
          last_organisation_id?: string | null
          updated_at?: string
        }
        Update: {
          job_type?: string
          last_organisation_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "queue_rotation_last_organisation_id_fkey"
            columns: ["last_organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "queue_rotation_last_organisation_id_fkey"
            columns: ["last_organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      reply_drafts: {
        Row: {
          ai_draft_body: string | null
          created_at: string
          draft_metadata: Json
          edited_at: string | null
          edited_by_user_id: string | null
          final_sent_body: string | null
          id: string
          instantly_message_id: string | null
          intent: string
          organisation_id: string
          prospect_id: string | null
          reviewed_at: string | null
          reviewed_by_user_id: string | null
          send_error: string | null
          sent_at: string | null
          signal_id: string
          status: string
          tier: number
          updated_at: string
        }
        Insert: {
          ai_draft_body?: string | null
          created_at?: string
          draft_metadata?: Json
          edited_at?: string | null
          edited_by_user_id?: string | null
          final_sent_body?: string | null
          id?: string
          instantly_message_id?: string | null
          intent: string
          organisation_id: string
          prospect_id?: string | null
          reviewed_at?: string | null
          reviewed_by_user_id?: string | null
          send_error?: string | null
          sent_at?: string | null
          signal_id: string
          status?: string
          tier: number
          updated_at?: string
        }
        Update: {
          ai_draft_body?: string | null
          created_at?: string
          draft_metadata?: Json
          edited_at?: string | null
          edited_by_user_id?: string | null
          final_sent_body?: string | null
          id?: string
          instantly_message_id?: string | null
          intent?: string
          organisation_id?: string
          prospect_id?: string | null
          reviewed_at?: string | null
          reviewed_by_user_id?: string | null
          send_error?: string | null
          sent_at?: string | null
          signal_id?: string
          status?: string
          tier?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reply_drafts_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_drafts_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_drafts_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "client_prospects_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_drafts_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "prospects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_drafts_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: true
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      reply_handling_actions: {
        Row: {
          action_error: string | null
          action_payload: Json | null
          action_succeeded: boolean | null
          action_taken: string
          attempt_number: number
          campaign_id: string | null
          classification_confidence: number | null
          classification_reasoning: string | null
          classified_intent: string | null
          created_at: string
          faq_entry_id: string | null
          id: string
          instantly_response: Json | null
          organisation_id: string
          prospect_id: string | null
          scheduled_resume_at: string | null
          signal_id: string
          tier_assigned: number | null
          updated_at: string
        }
        Insert: {
          action_error?: string | null
          action_payload?: Json | null
          action_succeeded?: boolean | null
          action_taken: string
          attempt_number?: number
          campaign_id?: string | null
          classification_confidence?: number | null
          classification_reasoning?: string | null
          classified_intent?: string | null
          created_at?: string
          faq_entry_id?: string | null
          id?: string
          instantly_response?: Json | null
          organisation_id: string
          prospect_id?: string | null
          scheduled_resume_at?: string | null
          signal_id: string
          tier_assigned?: number | null
          updated_at?: string
        }
        Update: {
          action_error?: string | null
          action_payload?: Json | null
          action_succeeded?: boolean | null
          action_taken?: string
          attempt_number?: number
          campaign_id?: string | null
          classification_confidence?: number | null
          classification_reasoning?: string | null
          classified_intent?: string | null
          created_at?: string
          faq_entry_id?: string | null
          id?: string
          instantly_response?: Json | null
          organisation_id?: string
          prospect_id?: string | null
          scheduled_resume_at?: string | null
          signal_id?: string
          tier_assigned?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_reply_handling_actions_faq_id"
            columns: ["faq_entry_id"]
            isOneToOne: false
            referencedRelation: "faqs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_handling_actions_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_handling_actions_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_handling_actions_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_handling_actions_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "client_prospects_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_handling_actions_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "prospects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_handling_actions_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      segments: {
        Row: {
          created_at: string
          id: string
          is_default: boolean
          name: string
          organisation_id: string
          slug: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_default?: boolean
          name: string
          organisation_id: string
          slug: string
        }
        Update: {
          created_at?: string
          id?: string
          is_default?: boolean
          name?: string
          organisation_id?: string
          slug?: string
        }
        Relationships: [
          {
            foreignKeyName: "segments_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segments_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      sending_health_snapshot: {
        Row: {
          computed_at: string
          detail: string
          domains: Json
          id: number
          overall_state: string
          window_end: string
          window_start: string
        }
        Insert: {
          computed_at?: string
          detail: string
          domains?: Json
          id?: number
          overall_state: string
          window_end: string
          window_start: string
        }
        Update: {
          computed_at?: string
          detail?: string
          domains?: Json
          id?: number
          overall_state?: string
          window_end?: string
          window_start?: string
        }
        Relationships: []
      }
      sending_mailbox_daily_stats: {
        Row: {
          bounces: number
          fetched_at: string
          id: string
          mailbox: string
          sending_domain: string
          sends: number
          stat_date: string
        }
        Insert: {
          bounces?: number
          fetched_at?: string
          id?: string
          mailbox: string
          sending_domain: string
          sends?: number
          stat_date: string
        }
        Update: {
          bounces?: number
          fetched_at?: string
          id?: string
          mailbox?: string
          sending_domain?: string
          sends?: number
          stat_date?: string
        }
        Relationships: []
      }
      signals: {
        Row: {
          campaign_id: string | null
          created_at: string
          external_event_id: string | null
          id: string
          organisation_id: string
          original_outbound_body: string | null
          original_outbound_message_id: string | null
          processed: boolean
          processed_at: string | null
          prospect_id: string | null
          raw_data: Json
          signal_type: string
          source: string | null
          variant_id: string | null
        }
        Insert: {
          campaign_id?: string | null
          created_at?: string
          external_event_id?: string | null
          id?: string
          organisation_id: string
          original_outbound_body?: string | null
          original_outbound_message_id?: string | null
          processed?: boolean
          processed_at?: string | null
          prospect_id?: string | null
          raw_data?: Json
          signal_type: string
          source?: string | null
          variant_id?: string | null
        }
        Update: {
          campaign_id?: string | null
          created_at?: string
          external_event_id?: string | null
          id?: string
          organisation_id?: string
          original_outbound_body?: string | null
          original_outbound_message_id?: string | null
          processed?: boolean
          processed_at?: string | null
          prospect_id?: string | null
          raw_data?: Json
          signal_type?: string
          source?: string | null
          variant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "signals_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signals_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signals_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signals_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "client_prospects_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signals_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "prospects"
            referencedColumns: ["id"]
          },
        ]
      }
      sourcing_runs: {
        Row: {
          agent_run_id: string | null
          backfilled_at: string | null
          candidates_returned: number
          completed_at: string | null
          created_at: string
          created_by: string | null
          dropped_by_reason: Json
          error_message: string | null
          icp_document_id: string | null
          id: string
          organisation_id: string
          prospects_written: number
          started_at: string
          status: string
          target_batch_size: number | null
          trigger_type: string
          updated_at: string
        }
        Insert: {
          agent_run_id?: string | null
          backfilled_at?: string | null
          candidates_returned?: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          dropped_by_reason?: Json
          error_message?: string | null
          icp_document_id?: string | null
          id?: string
          organisation_id: string
          prospects_written?: number
          started_at?: string
          status?: string
          target_batch_size?: number | null
          trigger_type: string
          updated_at?: string
        }
        Update: {
          agent_run_id?: string | null
          backfilled_at?: string | null
          candidates_returned?: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          dropped_by_reason?: Json
          error_message?: string | null
          icp_document_id?: string | null
          id?: string
          organisation_id?: string
          prospects_written?: number
          started_at?: string
          status?: string
          target_batch_size?: number | null
          trigger_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sourcing_runs_agent_run_id_fkey"
            columns: ["agent_run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sourcing_runs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sourcing_runs_icp_document_id_fkey"
            columns: ["icp_document_id"]
            isOneToOne: false
            referencedRelation: "strategy_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sourcing_runs_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sourcing_runs_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      strategy_documents: {
        Row: {
          approval_source: string | null
          approved_at: string | null
          change_summary: string | null
          client_approval_status: string | null
          content: Json
          created_at: string
          document_type: string
          generated_at: string | null
          icp_filter_spec: Json | null
          id: string
          is_stale: boolean
          last_updated_at: string
          organisation_id: string
          pending_since: string | null
          plain_text: string | null
          revision_note: string | null
          segment_id: string | null
          stale_reason: string | null
          status: string
          update_trigger: string | null
          updated_at: string
          version: string
        }
        Insert: {
          approval_source?: string | null
          approved_at?: string | null
          change_summary?: string | null
          client_approval_status?: string | null
          content?: Json
          created_at?: string
          document_type: string
          generated_at?: string | null
          icp_filter_spec?: Json | null
          id?: string
          is_stale?: boolean
          last_updated_at?: string
          organisation_id: string
          pending_since?: string | null
          plain_text?: string | null
          revision_note?: string | null
          segment_id?: string | null
          stale_reason?: string | null
          status?: string
          update_trigger?: string | null
          updated_at?: string
          version?: string
        }
        Update: {
          approval_source?: string | null
          approved_at?: string | null
          change_summary?: string | null
          client_approval_status?: string | null
          content?: Json
          created_at?: string
          document_type?: string
          generated_at?: string | null
          icp_filter_spec?: Json | null
          id?: string
          is_stale?: boolean
          last_updated_at?: string
          organisation_id?: string
          pending_since?: string | null
          plain_text?: string | null
          revision_note?: string | null
          segment_id?: string | null
          stale_reason?: string | null
          status?: string
          update_trigger?: string | null
          updated_at?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "strategy_documents_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "strategy_documents_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "strategy_documents_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
        ]
      }
      suppressed_emails: {
        Row: {
          carry_attempted_at: string | null
          carry_error: string | null
          carry_status: string | null
          created_at: string
          email: string
          id: string
          reason: string
          revoked_at: string | null
          revoked_reason: string | null
          source_org_id: string | null
          source_signal_id: string | null
        }
        Insert: {
          carry_attempted_at?: string | null
          carry_error?: string | null
          carry_status?: string | null
          created_at?: string
          email: string
          id?: string
          reason: string
          revoked_at?: string | null
          revoked_reason?: string | null
          source_org_id?: string | null
          source_signal_id?: string | null
        }
        Update: {
          carry_attempted_at?: string | null
          carry_error?: string | null
          carry_status?: string | null
          created_at?: string
          email?: string
          id?: string
          reason?: string
          revoked_at?: string | null
          revoked_reason?: string | null
          source_org_id?: string | null
          source_signal_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "suppressed_emails_source_org_id_fkey"
            columns: ["source_org_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "suppressed_emails_source_org_id_fkey"
            columns: ["source_org_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "suppressed_emails_source_signal_id_fkey"
            columns: ["source_signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      suppression_reconciliation_snapshot: {
        Row: {
          blocked_count: number
          carry_failed_count: number
          checked_count: number
          computed_at: string
          detail: string
          id: number
          incomplete: boolean
          invariant_breach_count: number
          settling_count: number
          uncarried_count: number
          unreachable_count: number
          unreconciled_count: number
          unreconciled_prospect_ids: Json
          uploaded_count: number
        }
        Insert: {
          blocked_count: number
          carry_failed_count?: number
          checked_count: number
          computed_at?: string
          detail: string
          id?: number
          incomplete?: boolean
          invariant_breach_count: number
          settling_count: number
          uncarried_count?: number
          unreachable_count: number
          unreconciled_count: number
          unreconciled_prospect_ids?: Json
          uploaded_count: number
        }
        Update: {
          blocked_count?: number
          carry_failed_count?: number
          checked_count?: number
          computed_at?: string
          detail?: string
          id?: number
          incomplete?: boolean
          invariant_breach_count?: number
          settling_count?: number
          uncarried_count?: number
          unreachable_count?: number
          unreconciled_count?: number
          unreconciled_prospect_ids?: Json
          uploaded_count?: number
        }
        Relationships: []
      }
      synthesis_batch_entries: {
        Row: {
          batch_id: string | null
          client_context: Json
          client_name: string
          created_at: string
          detected_signal: Json
          doc_superseded: boolean
          error: string | null
          id: string
          messaging_content: Json
          messaging_doc_id: string
          messaging_doc_version: string
          organisation_id: string
          phase1_run_id: string | null
          prospect_id: string
          raw_sources: Json
          response_message: Json | null
          result_type: string | null
          segment_id: string | null
          state: string
          stop_reason: string | null
          submit_attempts: number
          updated_at: string
          usage: Json | null
          variant_id: string
        }
        Insert: {
          batch_id?: string | null
          client_context: Json
          client_name: string
          created_at?: string
          detected_signal: Json
          doc_superseded?: boolean
          error?: string | null
          id?: string
          messaging_content: Json
          messaging_doc_id: string
          messaging_doc_version: string
          organisation_id: string
          phase1_run_id?: string | null
          prospect_id: string
          raw_sources: Json
          response_message?: Json | null
          result_type?: string | null
          segment_id?: string | null
          state?: string
          stop_reason?: string | null
          submit_attempts?: number
          updated_at?: string
          usage?: Json | null
          variant_id: string
        }
        Update: {
          batch_id?: string | null
          client_context?: Json
          client_name?: string
          created_at?: string
          detected_signal?: Json
          doc_superseded?: boolean
          error?: string | null
          id?: string
          messaging_content?: Json
          messaging_doc_id?: string
          messaging_doc_version?: string
          organisation_id?: string
          phase1_run_id?: string | null
          prospect_id?: string
          raw_sources?: Json
          response_message?: Json | null
          result_type?: string | null
          segment_id?: string | null
          state?: string
          stop_reason?: string | null
          submit_attempts?: number
          updated_at?: string
          usage?: Json | null
          variant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "synthesis_batch_entries_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "synthesis_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "synthesis_batch_entries_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "synthesis_batch_entries_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "synthesis_batch_entries_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "client_prospects_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "synthesis_batch_entries_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "prospects"
            referencedColumns: ["id"]
          },
        ]
      }
      synthesis_batches: {
        Row: {
          anthropic_batch_id: string | null
          cache_ttl: string
          collected_at: string | null
          counts: Json | null
          created_at: string
          ended_at: string | null
          error: string | null
          expires_at: string
          id: string
          last_polled_at: string | null
          model: string
          organisation_id: string
          poll_count: number
          request_count: number
          requested_at: string
          state: string
          submitted_at: string | null
          updated_at: string
        }
        Insert: {
          anthropic_batch_id?: string | null
          cache_ttl: string
          collected_at?: string | null
          counts?: Json | null
          created_at?: string
          ended_at?: string | null
          error?: string | null
          expires_at?: string
          id?: string
          last_polled_at?: string | null
          model: string
          organisation_id: string
          poll_count?: number
          request_count?: number
          requested_at?: string
          state?: string
          submitted_at?: string | null
          updated_at?: string
        }
        Update: {
          anthropic_batch_id?: string | null
          cache_ttl?: string
          collected_at?: string | null
          counts?: Json | null
          created_at?: string
          ended_at?: string | null
          error?: string | null
          expires_at?: string
          id?: string
          last_polled_at?: string | null
          model?: string
          organisation_id?: string
          poll_count?: number
          request_count?: number
          requested_at?: string
          state?: string
          submitted_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "synthesis_batches_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "synthesis_batches_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      system_flags: {
        Row: {
          enabled: boolean
          key: string
          note: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          enabled?: boolean
          key: string
          note?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          enabled?: boolean
          key?: string
          note?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      users: {
        Row: {
          created_at: string
          display_name: string | null
          email: string
          id: string
          last_seen_at: string | null
          organisation_id: string | null
          role: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email: string
          id: string
          last_seen_at?: string | null
          organisation_id?: string | null
          role: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string
          id?: string
          last_seen_at?: string | null
          organisation_id?: string | null
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "users_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "users_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      users_pending_review: {
        Row: {
          attempted_at: string
          attempted_org_id: string
          email: string
          id: string
          reviewed: boolean
        }
        Insert: {
          attempted_at?: string
          attempted_org_id: string
          email: string
          id?: string
          reviewed?: boolean
        }
        Update: {
          attempted_at?: string
          attempted_org_id?: string
          email?: string
          id?: string
          reviewed?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "users_pending_review_attempted_org_id_fkey"
            columns: ["attempted_org_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "users_pending_review_attempted_org_id_fkey"
            columns: ["attempted_org_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      verification_calls: {
        Row: {
          completed_at: string | null
          error: string | null
          id: string
          organisation_id: string
          outcome: string
          prospect_id: string | null
          provider: string
          requested_at: string
          score: number | null
          verdict: string | null
        }
        Insert: {
          completed_at?: string | null
          error?: string | null
          id?: string
          organisation_id: string
          outcome?: string
          prospect_id?: string | null
          provider: string
          requested_at?: string
          score?: number | null
          verdict?: string | null
        }
        Update: {
          completed_at?: string | null
          error?: string | null
          id?: string
          organisation_id?: string
          outcome?: string
          prospect_id?: string | null
          provider?: string
          requested_at?: string
          score?: number | null
          verdict?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "verification_calls_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_calls_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_calls_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "client_prospects_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_calls_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "prospects"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      client_organisation_view: {
        Row: {
          contract_start_date: string | null
          created_at: string | null
          id: string | null
          meetings_count: number | null
          name: string | null
          pipeline_unlock_at: string | null
          pipeline_unlocked: boolean | null
          slug: string | null
          updated_at: string | null
        }
        Insert: {
          contract_start_date?: string | null
          created_at?: string | null
          id?: string | null
          meetings_count?: number | null
          name?: string | null
          pipeline_unlock_at?: string | null
          pipeline_unlocked?: boolean | null
          slug?: string | null
          updated_at?: string | null
        }
        Update: {
          contract_start_date?: string | null
          created_at?: string | null
          id?: string | null
          meetings_count?: number | null
          name?: string | null
          pipeline_unlock_at?: string | null
          pipeline_unlocked?: boolean | null
          slug?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      client_prospects_view: {
        Row: {
          client_review_auto_approved_at: string | null
          client_review_reason: string | null
          client_review_status: string | null
          company_headcount: number | null
          company_industry: string | null
          company_name: string | null
          created_at: string | null
          first_name: string | null
          id: string | null
          job_title: string | null
          last_name: string | null
          linkedin_url: string | null
          organisation_id: string | null
          personalisation_trigger: string | null
          role: string | null
          sourced_tier: string | null
          suppressed: boolean | null
          website_url: string | null
        }
        Insert: {
          client_review_auto_approved_at?: string | null
          client_review_reason?: string | null
          client_review_status?: string | null
          company_headcount?: number | null
          company_industry?: string | null
          company_name?: string | null
          created_at?: string | null
          first_name?: string | null
          id?: string | null
          job_title?: string | null
          last_name?: string | null
          linkedin_url?: string | null
          organisation_id?: string | null
          personalisation_trigger?: string | null
          role?: string | null
          sourced_tier?: string | null
          suppressed?: boolean | null
          website_url?: string | null
        }
        Update: {
          client_review_auto_approved_at?: string | null
          client_review_reason?: string | null
          client_review_status?: string | null
          company_headcount?: number | null
          company_industry?: string | null
          company_name?: string | null
          created_at?: string | null
          first_name?: string | null
          id?: string | null
          job_title?: string | null
          last_name?: string | null
          linkedin_url?: string | null
          organisation_id?: string | null
          personalisation_trigger?: string | null
          role?: string | null
          sourced_tier?: string | null
          suppressed?: boolean | null
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "prospects_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prospects_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      mon_001: {
        Row: {
          check_code: string | null
          detail: string | null
          last_run: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_002: {
        Row: {
          check_code: string | null
          detail: string | null
          last_run: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_003: {
        Row: {
          check_code: string | null
          detail: string | null
          last_run: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_004: {
        Row: {
          check_code: string | null
          detail: string | null
          last_run: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_005: {
        Row: {
          check_code: string | null
          detail: string | null
          last_run: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_006: {
        Row: {
          check_code: string | null
          detail: string | null
          oldest_revision: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_010: {
        Row: {
          check_code: string | null
          detail: string | null
          last_run: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_011: {
        Row: {
          check_code: string | null
          detail: string | null
          oldest_incident: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_012: {
        Row: {
          check_code: string | null
          detail: string | null
          oldest_zombie: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_013: {
        Row: {
          check_code: string | null
          check_time: string | null
          detail: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_014: {
        Row: {
          check_code: string | null
          detail: string | null
          oldest_signal: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_015: {
        Row: {
          check_code: string | null
          detail: string | null
          newest_failure: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_016: {
        Row: {
          check_code: string | null
          detail: string | null
          last_run: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_017: {
        Row: {
          check_code: string | null
          detail: string | null
          last_run: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_018: {
        Row: {
          check_code: string | null
          detail: string | null
          last_run: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_019: {
        Row: {
          check_code: string | null
          detail: string | null
          last_run: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_020: {
        Row: {
          check_code: string | null
          detail: string | null
          last_run: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_021: {
        Row: {
          check_code: string | null
          detail: string | null
          last_run: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_022: {
        Row: {
          check_code: string | null
          detail: string | null
          last_run: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_023: {
        Row: {
          check_code: string | null
          detail: string | null
          last_run: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_024: {
        Row: {
          check_code: string | null
          detail: string | null
          last_run: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_025: {
        Row: {
          check_code: string | null
          detail: string | null
          last_run: string | null
          state: string | null
        }
        Relationships: []
      }
      mon_026: {
        Row: {
          check_code: string | null
          detail: string | null
          last_run: string | null
          state: string | null
        }
        Relationships: []
      }
      queue_depth: {
        Row: {
          claimed: number | null
          done_24h: number | null
          failed_24h: number | null
          failed_total: number | null
          job_type: string | null
          last_completion_at: string | null
          oldest_queued_age_seconds: number | null
          organisation_id: string | null
          queued: number | null
        }
        Relationships: [
          {
            foreignKeyName: "job_queue_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_queue_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      append_faq_variant: {
        Args: { p_faq_id: string; p_new_variant: string }
        Returns: undefined
      }
      approve_document_suggestion: {
        Args: { p_reviewer_id: string; p_suggestion_id: string }
        Returns: Json
      }
      claim_jobs: {
        Args: {
          p_job_type: string
          p_lease_seconds: number
          p_limit: number
          p_organisation_id: string
          p_worker: string
        }
        Returns: {
          attempts: number
          claimed_by: string | null
          created_at: string
          enqueued_by: string | null
          id: string
          job_type: string
          last_error: string | null
          last_error_class: string | null
          lease_expires_at: string | null
          max_attempts: number
          organisation_id: string
          prospect_id: string
          result_summary: string | null
          run_after: string
          spend_detail: Json | null
          spend_recorded_at: string | null
          state: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "job_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      complete_job: {
        Args: { p_job_id: string; p_summary: string; p_worker: string }
        Returns: {
          attempts: number
          claimed_by: string | null
          created_at: string
          enqueued_by: string | null
          id: string
          job_type: string
          last_error: string | null
          last_error_class: string | null
          lease_expires_at: string | null
          max_attempts: number
          organisation_id: string
          prospect_id: string
          result_summary: string | null
          run_after: string
          spend_detail: Json | null
          spend_recorded_at: string | null
          state: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "job_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      enqueue_job: {
        Args: {
          p_enqueued_by: string
          p_job_type: string
          p_max_attempts?: number
          p_organisation_id: string
          p_prospect_id: string
        }
        Returns: {
          attempts: number
          claimed_by: string | null
          created_at: string
          enqueued_by: string | null
          id: string
          job_type: string
          last_error: string | null
          last_error_class: string | null
          lease_expires_at: string | null
          max_attempts: number
          organisation_id: string
          prospect_id: string
          result_summary: string | null
          run_after: string
          spend_detail: Json | null
          spend_recorded_at: string | null
          state: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "job_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      enqueue_research_phase: {
        Args: {
          p_enqueued_by: string
          p_job_type: string
          p_max_attempts: number
          p_organisation_id: string
          p_prospect_id: string
        }
        Returns: {
          attempts: number
          claimed_by: string | null
          created_at: string
          enqueued_by: string | null
          id: string
          job_type: string
          last_error: string | null
          last_error_class: string | null
          lease_expires_at: string | null
          max_attempts: number
          organisation_id: string
          prospect_id: string
          result_summary: string | null
          run_after: string
          spend_detail: Json | null
          spend_recorded_at: string | null
          state: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "job_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      fail_job: {
        Args: {
          p_error: string
          p_error_class: string
          p_force_terminal?: boolean
          p_job_id: string
          p_worker: string
        }
        Returns: {
          attempts: number
          claimed_by: string | null
          created_at: string
          enqueued_by: string | null
          id: string
          job_type: string
          last_error: string | null
          last_error_class: string | null
          lease_expires_at: string | null
          max_attempts: number
          organisation_id: string
          prospect_id: string
          result_summary: string | null
          run_after: string
          spend_detail: Json | null
          spend_recorded_at: string | null
          state: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "job_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_my_organisation_id: { Args: never; Returns: string }
      is_operator: { Args: never; Returns: boolean }
      job_queue_backoff: { Args: { p_attempts: number }; Returns: string }
      promote_strategy_doc_version: {
        Args: {
          p_change_summary?: string
          p_content: Json
          p_doc_type: string
          p_org_id: string
          p_revision_note?: string
          p_segment_id: string
          p_update_trigger: string
        }
        Returns: Json
      }
      queue_next_organisations: {
        Args: { p_job_type: string }
        Returns: {
          depth: number
          oldest: string
          organisation_id: string
        }[]
      }
      reclaim_expired_jobs: {
        Args: { p_limit?: number }
        Returns: {
          attempts: number
          claimed_by: string | null
          created_at: string
          enqueued_by: string | null
          id: string
          job_type: string
          last_error: string | null
          last_error_class: string | null
          lease_expires_at: string | null
          max_attempts: number
          organisation_id: string
          prospect_id: string
          result_summary: string | null
          run_after: string
          spend_detail: Json | null
          spend_recorded_at: string | null
          state: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "job_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      record_job_spend: {
        Args: { p_detail: Json; p_job_id: string }
        Returns: undefined
      }
      revert_strategy_doc_version: {
        Args: { p_document_id: string }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
