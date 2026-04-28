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
          client_id: string
          completed_at: string | null
          duration_ms: number | null
          error_message: string | null
          id: string
          output_summary: string | null
          started_at: string
          status: string
        }
        Insert: {
          agent_name: string
          client_id: string
          completed_at?: string | null
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          output_summary?: string | null
          started_at?: string
          status: string
        }
        Update: {
          agent_name?: string
          client_id?: string
          completed_at?: string | null
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          output_summary?: string | null
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_runs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          campaign_type: string
          created_at: string
          external_id: string | null
          id: string
          organisation_id: string
          paused_at: string | null
          sequence_name: string | null
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          campaign_type: string
          created_at?: string
          external_id?: string | null
          id?: string
          organisation_id: string
          paused_at?: string | null
          sequence_name?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          campaign_type?: string
          created_at?: string
          external_id?: string | null
          id?: string
          organisation_id?: string
          paused_at?: string | null
          sequence_name?: string | null
          started_at?: string | null
          status?: string
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
          sequence_position: number | null
          signal_count: number
          status: string
          suggested_value: string
          suggestion_reason: string | null
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
          sequence_position?: number | null
          signal_count?: number
          status?: string
          suggested_value: string
          suggestion_reason?: string | null
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
          sequence_position?: number | null
          signal_count?: number
          status?: string
          suggested_value?: string
          suggestion_reason?: string | null
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
        ]
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
        ]
      }
      intake_website_pages: {
        Row: {
          created_at: string
          display_order: number
          error_message: string | null
          extracted_text: string | null
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
          tool_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      meetings: {
        Row: {
          booked_at: string
          campaign_id: string | null
          created_at: string
          id: string
          meeting_date: string | null
          organisation_id: string
          prospect_id: string | null
          qualification: string | null
          qualification_notes: string | null
          revenue_value: number | null
          status: string
          updated_at: string
        }
        Insert: {
          booked_at?: string
          campaign_id?: string | null
          created_at?: string
          id?: string
          meeting_date?: string | null
          organisation_id: string
          prospect_id?: string | null
          qualification?: string | null
          qualification_notes?: string | null
          revenue_value?: number | null
          status?: string
          updated_at?: string
        }
        Update: {
          booked_at?: string
          campaign_id?: string | null
          created_at?: string
          id?: string
          meeting_date?: string | null
          organisation_id?: string
          prospect_id?: string | null
          qualification?: string | null
          qualification_notes?: string | null
          revenue_value?: number | null
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
            referencedRelation: "prospects"
            referencedColumns: ["id"]
          },
        ]
      }
      organisations: {
        Row: {
          auto_approve_window_hours: number
          contract_start_date: string | null
          contract_status: string | null
          created_at: string
          engagement_month: number
          founder_first_name: string | null
          id: string
          meetings_count: number
          name: string
          payment_status: string | null
          pipeline_unlock_at: string | null
          pipeline_unlock_manual_override: boolean
          pipeline_unlocked: boolean
          slug: string
          updated_at: string
        }
        Insert: {
          auto_approve_window_hours?: number
          contract_start_date?: string | null
          contract_status?: string | null
          created_at?: string
          engagement_month?: number
          founder_first_name?: string | null
          id?: string
          meetings_count?: number
          name: string
          payment_status?: string | null
          pipeline_unlock_at?: string | null
          pipeline_unlock_manual_override?: boolean
          pipeline_unlocked?: boolean
          slug: string
          updated_at?: string
        }
        Update: {
          auto_approve_window_hours?: number
          contract_start_date?: string | null
          contract_status?: string | null
          created_at?: string
          engagement_month?: number
          founder_first_name?: string | null
          id?: string
          meetings_count?: number
          name?: string
          payment_status?: string | null
          pipeline_unlock_at?: string | null
          pipeline_unlock_manual_override?: boolean
          pipeline_unlocked?: boolean
          slug?: string
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
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
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
      prospect_research_results: {
        Row: {
          created_at: string
          has_dateable_signal: boolean
          id: string
          icp_fit: string
          organisation_id: string
          prospect_id: string
          qualification_reason: string | null
          qualification_status: string
          raw_apollo: Json | null
          raw_linkedin: Json | null
          raw_web_search: Json | null
          raw_website: Json | null
          run_id: string | null
          signal_observation: string | null
          sources_attempted: string[]
          sources_successful: string[]
          synthesis_confidence: string | null
          synthesis_reasoning: string | null
          synthesized_at: string
          trigger_source: Json | null
          trigger_text: string | null
        }
        Insert: {
          created_at?: string
          has_dateable_signal?: boolean
          id?: string
          icp_fit?: string
          organisation_id: string
          prospect_id: string
          qualification_reason?: string | null
          qualification_status?: string
          raw_apollo?: Json | null
          raw_linkedin?: Json | null
          raw_web_search?: Json | null
          raw_website?: Json | null
          run_id?: string | null
          signal_observation?: string | null
          sources_attempted?: string[]
          sources_successful?: string[]
          synthesis_confidence?: string | null
          synthesis_reasoning?: string | null
          synthesized_at?: string
          trigger_source?: Json | null
          trigger_text?: string | null
        }
        Update: {
          created_at?: string
          has_dateable_signal?: boolean
          id?: string
          icp_fit?: string
          organisation_id?: string
          prospect_id?: string
          qualification_reason?: string | null
          qualification_status?: string
          raw_apollo?: Json | null
          raw_linkedin?: Json | null
          raw_web_search?: Json | null
          raw_website?: Json | null
          run_id?: string | null
          signal_observation?: string | null
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
          classified_at: string | null
          company_name: string | null
          created_at: string
          current_research_result_id: string | null
          email: string | null
          first_name: string | null
          has_dateable_signal: boolean
          id: string
          icp_fit: string
          last_name: string | null
          linkedin_url: string | null
          organisation_id: string
          personalisation_trigger: string | null
          qualification_status: string | null
          research_ran_at: string | null
          research_source: string | null
          role: string | null
          signal_observation: string | null
          suppressed: boolean
          suppressed_at: string | null
          suppression_reason: string | null
          trigger_confidence: string | null
          trigger_data: Json | null
          updated_at: string
          variant_id: string | null
        }
        Insert: {
          classified_at?: string | null
          company_name?: string | null
          created_at?: string
          current_research_result_id?: string | null
          email?: string | null
          first_name?: string | null
          has_dateable_signal?: boolean
          id?: string
          icp_fit?: string
          last_name?: string | null
          linkedin_url?: string | null
          organisation_id: string
          personalisation_trigger?: string | null
          qualification_status?: string | null
          research_ran_at?: string | null
          research_source?: string | null
          role?: string | null
          signal_observation?: string | null
          suppressed?: boolean
          suppressed_at?: string | null
          suppression_reason?: string | null
          trigger_confidence?: string | null
          trigger_data?: Json | null
          updated_at?: string
          variant_id?: string | null
        }
        Update: {
          classified_at?: string | null
          company_name?: string | null
          created_at?: string
          current_research_result_id?: string | null
          email?: string | null
          first_name?: string | null
          has_dateable_signal?: boolean
          id?: string
          icp_fit?: string
          last_name?: string | null
          linkedin_url?: string | null
          organisation_id?: string
          personalisation_trigger?: string | null
          qualification_status?: string | null
          research_ran_at?: string | null
          research_source?: string | null
          role?: string | null
          signal_observation?: string | null
          suppressed?: boolean
          suppressed_at?: string | null
          suppression_reason?: string | null
          trigger_confidence?: string | null
          trigger_data?: Json | null
          updated_at?: string
          variant_id?: string | null
        }
        Relationships: [
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
        ]
      }
      signals: {
        Row: {
          campaign_id: string | null
          created_at: string
          external_event_id: string | null
          id: string
          organisation_id: string
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
            referencedRelation: "prospects"
            referencedColumns: ["id"]
          },
        ]
      }
      strategy_documents: {
        Row: {
          content: Json
          created_at: string
          document_type: string
          generated_at: string | null
          id: string
          is_stale: boolean
          last_updated_at: string
          organisation_id: string
          plain_text: string | null
          status: string
          update_trigger: string | null
          version: string
        }
        Insert: {
          content?: Json
          created_at?: string
          document_type: string
          generated_at?: string | null
          id?: string
          is_stale?: boolean
          last_updated_at?: string
          organisation_id: string
          plain_text?: string | null
          status?: string
          update_trigger?: string | null
          version?: string
        }
        Update: {
          content?: Json
          created_at?: string
          document_type?: string
          generated_at?: string | null
          id?: string
          is_stale?: boolean
          last_updated_at?: string
          organisation_id?: string
          plain_text?: string | null
          status?: string
          update_trigger?: string | null
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
        ]
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
    }
    Functions: {
      approve_document_suggestion: {
        Args: { p_reviewer_id: string; p_suggestion_id: string }
        Returns: Json
      }
      get_my_organisation_id: { Args: never; Returns: string }
      is_operator: { Args: never; Returns: boolean }
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
